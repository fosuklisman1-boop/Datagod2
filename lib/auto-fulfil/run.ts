import type { SupabaseClient } from "@supabase/supabase-js"
import { findBlacklistedPhones } from "@/lib/blacklist"
import { judgeOrder, type OrderSnapshot, type Verdict } from "@/lib/order-queue/eligibility"
import { loadSnapshots, normalizeNetwork } from "@/lib/order-queue/load-snapshots"
import { getProviderOptionsForNetwork } from "@/lib/order-queue/supplier-capability"
import { ORDER_TYPES, type OrderType } from "@/lib/order-queue/types"
import { notifyAdminsPush } from "@/lib/push-service"
import { decideCandidate, latestFailure, NON_SEND_SWITCHED_OFF, type Decision, type FailureEvent } from "./policy"
import { loadAutoFulfilSettings, type AutoFulfilSettings } from "./settings"

export type RunSummary = {
  ran: boolean
  reason?: "off" | "invalid_settings" | "busy"
  runId?: string
  queued: number
  waiting: number
  needsYou: number
  skipped: Record<string, number>
  cancelled: number
}

const SCAN = 300
const CHUNK = 100
const PAGE = 1000
const SUMMARY_EVERY_MINUTES = 60
/** An unfinished run younger than this blocks a new one; an older one is treated as crashed. */
const BUSY_WINDOW_MINUTES = 2
/** fulfillment_logs statuses meaning the order may be with (or delivered by) the supplier. */
const LIVE_LOG_STATUSES = ["success", "pending", "processing"]
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TAG = "[AUTO-FULFIL]"

type Candidate = { id: string; type: OrderType; network: string; phone: string | null; createdAt: string }

const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, i * CHUNK + CHUNK))

/** Reads every matching row, paging past PostgREST's 1000-row cap. Throws on any error (fail closed). */
async function readAll(build: () => any, what: string): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().order("id").range(from, from + PAGE - 1)
    if (error) throw new Error(`auto-fulfil: ${what} read failed: ${error.message}`)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

/** Long digit runs (phone numbers) never reach a log line or the run row. */
export const scrubDigits = (s: string) => s.replace(/\d{7,}/g, "[n]")

/** Tracking timestamps are "timestamp without time zone" written in UTC: read a zone-less value as UTC. */
function asUtc(at: unknown): string {
  const s = String(at ?? "")
  if (!s) return ""
  return /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(s) ? s : `${s.replace(" ", "T")}Z`
}

/**
 * Moves automatic rows still waiting in the queue to failed (they were never sent). Admin rows and rows the drain
 * already claimed are untouched. Throws on a write error.
 */
export async function cancelWaitingAutoRows(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from("fulfillment_queue")
    .update({ status: "failed", error_message: NON_SEND_SWITCHED_OFF })
    .eq("source", "auto")
    .eq("status", "pending")
    .select("id")
  if (error) throw new Error(`auto-fulfil: cancelling waiting auto rows failed: ${error.message}`)
  return (data ?? []).length
}

export type Switches = { mtn: boolean; nonMtn: Set<string> }

/**
 * The existing auto-fulfilment switches. A missing row or read error = that switch off. nonMtn holds the normalised
 * networks the non-MTN switch covers (empty when that switch is off).
 */
export async function readSwitches(db: SupabaseClient): Promise<Switches> {
  const read = async (key: string): Promise<any> => {
    try {
      const { data, error } = await db.from("admin_settings").select("value").eq("key", key).maybeSingle()
      if (error || !data) return null
      return (data as { value: unknown }).value ?? null
    } catch {
      return null
    }
  }
  const [mtnVal, nonMtnVal] = await Promise.all([read("mtn_auto_fulfillment_enabled"), read("auto_fulfillment_enabled")])
  const mtn = mtnVal?.enabled === true
  const nonMtn = new Set<string>()
  if (nonMtnVal?.enabled === true && Array.isArray(nonMtnVal.networks)) {
    for (const n of nonMtnVal.networks) if (typeof n === "string") nonMtn.add(normalizeNetwork(n))
  }
  return { mtn, nonMtn }
}

function networkOn(network: string, settings: AutoFulfilSettings, sw: Switches): boolean {
  if (!settings.networks.includes(network)) return false
  return network === "MTN" ? sw.mtn : sw.nonMtn.has(network)
}

/** judgeOrder in auto mode: the first supplier offered for the order's own network passes the capability check. */
function judge(o: OrderSnapshot | null): Verdict {
  const capable = o ? getProviderOptionsForNetwork((o.network ?? "").trim())[0]?.value ?? "" : ""
  return judgeOrder(o, capable)
}

type History = {
  heldOrReversed: Set<string>
  /** Orders with a fulfillment_logs row in success/pending/processing: treated as a live attempt. */
  liveLog: Set<string>
  events: Map<string, FailureEvent[]>
  autoTries: Map<string, number>
}

/**
 * Tracking rows, fulfillment_logs rows, failed queue rows and automatic attempts for the candidates.
 * Ids only; throws on any read error.
 */
async function readHistory(db: SupabaseClient, ids: string[]): Promise<History> {
  const idSet = new Set(ids)
  const heldOrReversed = new Set<string>()
  const liveLog = new Set<string>()
  const events = new Map<string, FailureEvent[]>()
  const autoTries = new Map<string, number>()
  const push = (id: string, e: FailureEvent) => events.set(id, [...(events.get(id) ?? []), e])

  // 1. Tracking rows, through every link column (a row filed under any of them counts). Dedupe by (row, order).
  const uuidIds = ids.filter((id) => UUID_RE.test(id))
  const seen = new Set<string>()
  for (const { col, list } of [
    { col: "order_id", list: ids },
    { col: "shop_order_id", list: uuidIds },
    { col: "api_order_id", list: uuidIds },
  ]) {
    for (const chunk of chunks(list)) {
      const rows = await readAll(
        () =>
          db
            .from("mtn_fulfillment_tracking")
            .select("id, order_id, shop_order_id, api_order_id, status, mtn_order_id, created_at, external_message, api_response_payload")
            .in(col, chunk),
        "tracking",
      )
      for (const t of rows) {
        const orderId = String(t[col] ?? "")
        if (!idSet.has(orderId)) continue
        const key = `${t.id}|${orderId}`
        if (seen.has(key)) continue
        seen.add(key)
        const status = String(t.status ?? "").toLowerCase()
        const mtnOrderId: string | null = t.mtn_order_id ?? null
        if (status === "abandoned" || status === "reversed" || (mtnOrderId ?? "").startsWith("UNKNOWN_")) heldOrReversed.add(orderId)
        const payloadMsg = t.api_response_payload && typeof t.api_response_payload === "object" ? t.api_response_payload.message : null
        push(orderId, {
          at: asUtc(t.created_at),
          source: "tracking",
          status,
          mtnOrderId,
          message: t.external_message ?? (typeof payloadMsg === "string" ? payloadMsg : null),
        })
      }
    }
  }

  // 1b. fulfillment_logs (CodeCraft non-MTN; uuid columns order_id / api_order_id). A live or delivered row blocks the
  //     order; a failed row is a failure event classified by the queue keyword rules (unknown text => a person).
  const seenLog = new Set<string>()
  for (const col of ["order_id", "api_order_id"]) {
    for (const chunk of chunks(uuidIds)) {
      const rows = await readAll(
        () => db.from("fulfillment_logs").select("id, order_id, api_order_id, status, error_message, updated_at").in(col, chunk),
        "fulfillment_logs",
      )
      for (const l of rows) {
        const orderId = String(l[col] ?? "")
        if (!idSet.has(orderId)) continue
        const key = `${l.id}|${orderId}`
        if (seenLog.has(key)) continue
        seenLog.add(key)
        const status = String(l.status ?? "").toLowerCase()
        if (LIVE_LOG_STATUSES.includes(status)) liveLog.add(orderId)
        else if (status === "failed") {
          push(orderId, { at: asUtc(l.updated_at), source: "queue", status: "failed", mtnOrderId: null, message: l.error_message ?? null })
        }
      }
    }
  }

  // 2. Failed queue rows, any source (latestFailure ignores the drain's own non-send messages).
  for (const chunk of chunks(ids)) {
    const rows = await readAll(
      () =>
        db
          .from("fulfillment_queue")
          .select("id, order_id, status, error_message, enqueued_at, last_attempted_at, completed_at")
          .in("order_id", chunk)
          .eq("status", "failed"),
      "fulfillment_queue history",
    )
    for (const q of rows) {
      const orderId = String(q.order_id)
      if (!idSet.has(orderId)) continue
      push(orderId, {
        at: String(q.completed_at ?? q.last_attempted_at ?? q.enqueued_at ?? ""),
        source: "queue",
        status: "failed",
        mtnOrderId: null,
        message: q.error_message ?? null,
      })
    }
  }

  // 3. Automatic sends. Read every row and filter here: a NULL outcome (send possibly in flight) must count, and a
  //    PostgREST neq filter would drop NULLs.
  for (const chunk of chunks(ids)) {
    const rows = await readAll(() => db.from("auto_fulfil_attempts").select("id, order_id, outcome").in("order_id", chunk), "auto_fulfil_attempts")
    for (const a of rows) {
      const orderId = String(a.order_id)
      if (!idSet.has(orderId) || a.outcome === "skipped") continue
      autoTries.set(orderId, (autoTries.get(orderId) ?? 0) + 1)
    }
  }

  return { heldOrReversed, liveLog, events, autoTries }
}

/** Bulk/shop candidates whose order row has queue = 'blacklisted' (only orders and shop_orders have the column). */
async function readBlacklistedQueue(db: SupabaseClient, candidates: Candidate[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (const { type, table } of [
    { type: "bulk", table: "orders" },
    { type: "shop", table: "shop_orders" },
  ] as const) {
    const ids = candidates.filter((c) => c.type === type).map((c) => c.id)
    for (const chunk of chunks(ids)) {
      const rows = await readAll(() => db.from(table).select("id, queue").in("id", chunk), `${table} queue flag`)
      for (const r of rows) if (r.queue === "blacklisted") out.add(String(r.id))
    }
  }
  return out
}

function parseCandidates(data: unknown): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()
  for (const r of (Array.isArray(data) ? data : []) as any[]) {
    const id = String(r?.id ?? "")
    if (!id || seen.has(id) || !ORDER_TYPES.includes(r?.type)) continue
    seen.add(id)
    out.push({ id, type: r.type, network: normalizeNetwork(r.network), phone: r.phone_number ?? null, createdAt: String(r.created_at ?? "") })
  }
  const t = (c: Candidate) => Date.parse(c.createdAt) || 0
  return out.sort((a, b) => t(a) - t(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * One cron tick: finds age-gated pending orders and queues the ones the policy allows as `source = 'auto'` rows
 * for the normal drain. Off or invalid settings => cancels waiting automatic rows and does nothing else.
 * Every read happens before any queue write; a failed read marks the run row and rethrows.
 * Phone numbers stay in memory (blacklist check only): never logged, stored or returned.
 */
export async function runAutoFulfil(db: SupabaseClient, now: Date = new Date()): Promise<RunSummary> {
  const { settings, valid } = await loadAutoFulfilSettings(db)
  if (!valid || !settings.enabled) {
    const cancelled = await cancelWaitingAutoRows(db)
    return { ran: false, reason: valid ? "off" : "invalid_settings", queued: 0, waiting: 0, needsYou: 0, skipped: {}, cancelled }
  }

  // Single flight: another run that started recently and has not finished owns this tick. Older unfinished rows
  // are crashed runs and do not block. Read error => throw (no run without knowing).
  const busySince = new Date(now.getTime() - BUSY_WINDOW_MINUTES * 60_000).toISOString()
  const { data: liveRuns, error: busyErr } = await db
    .from("auto_fulfil_runs")
    .select("id")
    .is("finished_at", null)
    .gte("started_at", busySince)
    .limit(1)
  if (busyErr) throw new Error(`auto-fulfil: run check failed: ${busyErr.message}`)
  if ((liveRuns ?? []).length > 0) {
    return { ran: false, reason: "busy", queued: 0, waiting: 0, needsYou: 0, skipped: {}, cancelled: 0 }
  }

  const switches = await readSwitches(db)
  const startedAt = now.toISOString()
  const { data: runRow, error: runErr } = await db.from("auto_fulfil_runs").insert({ started_at: startedAt }).select("id").single()
  if (runErr || !runRow) throw new Error(`auto-fulfil: run row insert failed: ${runErr?.message ?? "no row"}`)
  const runId = String((runRow as { id: string }).id)

  const summary: RunSummary = { ran: true, runId, queued: 0, waiting: 0, needsYou: 0, skipped: {}, cancelled: 0 }
  const skip = (reason: string) => (summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1)

  let toQueue: Candidate[] = []
  try {
    // 1. Reads (all before any write).
    const { data, error } = await db.rpc("auto_fulfil_candidates", {
      p_min_age_minutes: settings.minAgeMinutes,
      p_max_age_days: settings.maxAgeDays,
      p_networks: settings.networks,
      p_scan: SCAN,
    })
    if (error) throw new Error(`auto-fulfil: candidates read failed: ${error.message}`)
    const candidates = parseCandidates(data)

    const snaps = await loadSnapshots(db, candidates.map((c) => ({ id: c.id, type: c.type })))
    const history = await readHistory(db, candidates.map((c) => c.id))
    const blacklisted = await findBlacklistedPhones(candidates.map((c) => c.phone), db)
    const blacklistedQueue = await readBlacklistedQueue(db, candidates)

    // 2. Decide (pure).
    for (const c of candidates) {
      if (blacklistedQueue.has(c.id)) {
        skip("blacklisted_queue")
        continue
      }
      const raw = snaps.get(c.id) ?? null
      // A live/delivered fulfillment_logs row is a live attempt: judgeOrder then blocks it as live_at_supplier.
      const snap = raw && history.liveLog.has(c.id) ? { ...raw, hasLiveAttempt: true } : raw
      const decision: Decision = decideCandidate(
        {
          verdict: judge(snap),
          everHeldOrReversed: history.heldOrReversed.has(c.id),
          failure: latestFailure(history.events.get(c.id) ?? []),
          autoTries: history.autoTries.get(c.id) ?? 0,
          blacklisted: !!c.phone && blacklisted.has(c.phone),
          networkSwitchOn: networkOn(snap?.network ?? c.network, settings, switches),
        },
        settings,
        now,
      )
      if (decision.kind === "queue") toQueue.push(c)
      else if (decision.kind === "wait") summary.waiting++
      else if (decision.kind === "needs_you") summary.needsYou++
      else skip(decision.reason)
    }
  } catch (e) {
    const message = scrubDigits(e instanceof Error ? e.message : String(e)).slice(0, 500)
    const { error: upErr } = await db.from("auto_fulfil_runs").update({ error: message, finished_at: new Date().toISOString() }).eq("id", runId)
    if (upErr) console.error(`${TAG} run ${runId}: could not record the error`)
    throw e
  }

  // 3. Writes, oldest first, one order at a time.
  const overLimit = toQueue.length - settings.perRun
  if (overLimit > 0) {
    summary.skipped.per_run_limit = overLimit
    toQueue = toQueue.slice(0, settings.perRun)
  }
  for (const c of toQueue) {
    const { data: qRow, error: qErr } = await db
      .from("fulfillment_queue")
      .insert({ batch_id: runId, order_id: c.id, order_type: c.type, provider: null, source: "auto" })
      .select("id")
      .single()
    if (qErr || !qRow) {
      if (qErr?.code === "23505") skip("already_queued")
      else {
        console.error(`${TAG} run ${runId}: queue insert failed for order ${c.id}`)
        skip("insert_failed")
      }
      continue
    }
    const queueId = String((qRow as { id: string }).id)
    const { error: aErr } = await db
      .from("auto_fulfil_attempts")
      .insert({ run_id: runId, queue_id: queueId, order_id: c.id, order_type: c.type })
    if (aErr) {
      // Without the attempt record the try would not count, so take the row back while it still waits.
      console.error(`${TAG} run ${runId}: attempt record failed for order ${c.id} (queue ${queueId}); removing the waiting row`)
      const { error: delErr } = await db.from("fulfillment_queue").delete().eq("id", queueId).eq("status", "pending")
      if (delErr) console.error(`${TAG} run ${runId}: could not remove queue row ${queueId}`)
      skip("attempt_record_failed")
      continue
    }
    summary.queued++
  }

  // 4. Run row.
  const { error: finErr } = await db
    .from("auto_fulfil_runs")
    .update({
      queued: summary.queued,
      waiting: summary.waiting,
      needs_you: summary.needsYou,
      skipped: summary.skipped,
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId)
  if (finErr) console.error(`${TAG} run ${runId}: could not record the counts`)

  // 5. One phone-free summary push per hour at most.
  if (summary.needsYou > 0) await maybeSendSummary(db, runId, summary.needsYou, now)

  console.log(
    `${TAG} run ${runId} queued=${summary.queued} waiting=${summary.waiting} needsYou=${summary.needsYou} skipped=${JSON.stringify(summary.skipped)}`,
  )
  return summary
}

async function maybeSendSummary(db: SupabaseClient, runId: string, needsYou: number, now: Date): Promise<void> {
  const since = new Date(now.getTime() - SUMMARY_EVERY_MINUTES * 60_000).toISOString()
  const { data, error } = await db.from("auto_fulfil_runs").select("id").eq("summary_sent", true).gte("started_at", since).limit(1)
  // Unknown throttle state => stay quiet rather than risk a flood.
  if (error || (data ?? []).length > 0) return
  try {
    await notifyAdminsPush({
      title: "Auto-fulfil",
      body: `${needsYou} orders need you on Order Payment Status`,
      data: { url: "/admin/order-payment-status" },
    })
  } catch {
    console.error(`${TAG} run ${runId}: summary push failed`)
    return
  }
  const { error: upErr } = await db.from("auto_fulfil_runs").update({ summary_sent: true }).eq("id", runId)
  if (upErr) console.error(`${TAG} run ${runId}: could not mark the summary as sent`)
}
