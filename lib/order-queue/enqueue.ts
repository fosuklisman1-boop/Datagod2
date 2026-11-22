import type { SupabaseClient } from "@supabase/supabase-js"
import { checkRiskyAck, judgeOrder, type OrderSnapshot, type Verdict } from "./eligibility"
import { loadSnapshots, ORDER_TABLES } from "./load-snapshots"
import { allSuppliers, getProviderOptionsForNetwork } from "./supplier-capability"
import { ORDER_TYPES, type OrderType } from "./types"

/** Hard cap per request, for both the explicit-supplier send and the legacy auto-routing queue. */
export const MAX_BULK_SEND = 200

/**
 * Networks an explicit supplier pick may be sent for. Outside these (e.g. "AirtelTigo", "AT") the fulfilment
 * code would map the order to some other network key and could silently re-route the pick, so it is refused.
 */
export const BULK_SEND_NETWORKS = ["MTN", "Telecel", "AT - iShare", "AT - BigTime"]

/** Extra reasons the send step itself can give, beyond judgeOrder's blocked reasons. */
export type SendRejectReason =
  | Extract<Verdict, { kind: "blocked" }>["reason"]
  | "needs_confirmation"
  | "duplicate_in_request"
  | "changed"
  | "update_failed"
  | "insert_failed"

export type EnqueueRequest = {
  orders: { id: string; type: OrderType }[]
  /** null = legacy auto routing (no supplier pinned; the drain's normal routing picks one). */
  provider: string | null
  riskyAck?: { count: number }
}

export type EnqueueResult =
  | { status: 200; body: { batchId: string; queued: string[]; rejected: { id: string; reason: SendRejectReason }[]; risky: string[] } }
  | { status: 400; body: { error: "risky_ack_mismatch"; expected: number } }
  | { status: 400; body: { error: "risky_requires_supplier" } }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isKnownSupplier(name: string): boolean {
  return allSuppliers().some((s) => s.value === name)
}

/** Validates the POST body shape. Never touches the database. */
export function parseEnqueueBody(body: unknown): { ok: true; value: EnqueueRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid body" }
  const b = body as Record<string, unknown>
  const orders = b.orders
  if (!Array.isArray(orders) || orders.length === 0) return { ok: false, error: "orders array is required" }
  if (orders.length > MAX_BULK_SEND) return { ok: false, error: `at most ${MAX_BULK_SEND} orders per request` }
  const parsed: { id: string; type: OrderType }[] = []
  for (const o of orders) {
    const id = (o as any)?.id
    const type = (o as any)?.type
    // Every order table's id is a uuid. Anything else would 500 the batch (22P02) or, with `"`/`,`,
    // could alter the PostgREST in.(...) list, so it is refused before any read.
    if (typeof id !== "string" || !UUID_RE.test(id)) return { ok: false, error: "invalid_order_id" }
    if (!ORDER_TYPES.includes(type)) return { ok: false, error: "each order needs a valid type" }
    parsed.push({ id: id.toLowerCase(), type })
  }

  let provider: string | null = null
  if (b.provider !== undefined && b.provider !== null) {
    if (typeof b.provider !== "string" || !isKnownSupplier(b.provider)) return { ok: false, error: "unknown provider" }
    provider = b.provider
  }

  let riskyAck: { count: number } | undefined
  if (b.riskyAck !== undefined && b.riskyAck !== null) {
    const count = (b.riskyAck as any)?.count
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return { ok: false, error: "invalid riskyAck" }
    riskyAck = { count }
  }
  return { ok: true, value: { orders: parsed, provider, riskyAck } }
}

/** judgeOrder for this request: auto mode skips only the supplier-capability check; explicit mode also refuses unmapped networks. */
function judge(o: OrderSnapshot | null, provider: string | null): Verdict {
  if (provider === null) {
    // Any supplier offered for the order's own network passes judgeOrder's capability check (the list is never empty).
    const capable = o ? getProviderOptionsForNetwork((o.network ?? "").trim())[0]?.value ?? "" : ""
    return judgeOrder(o, capable)
  }
  const v = judgeOrder(o, provider)
  if (v.kind !== "blocked" && o && !BULK_SEND_NETWORKS.includes(o.network)) {
    return { kind: "blocked", reason: "supplier_cannot_serve_network" }
  }
  return v
}

/**
 * Server-checked bulk send. Every order is re-read and judged BEFORE any write; a riskyAck mismatch returns
 * 400 with nothing written. Accepted risky (held/reversed) orders are moved to `pending` guarded on their
 * current status, then each order gets ONE fulfillment_queue insert (a 23505 from the one-live-row index
 * means another send got there first). One admin_bulk_send_log row per request. Logs carry ids/counts only.
 */
export async function runEnqueue(db: SupabaseClient, req: EnqueueRequest, adminId: string): Promise<EnqueueResult> {
  // Releasing a held/reversed order is only safe hard-pinned to the supplier the admin checked it at; auto
  // routing could send it to a different supplier than the one that may already hold it. Refused before any read.
  if (req.riskyAck !== undefined && req.provider === null) return { status: 400, body: { error: "risky_requires_supplier" } }

  const rejected: { id: string; reason: SendRejectReason }[] = []
  const unique: { id: string; type: OrderType }[] = []
  const seen = new Set<string>()
  for (const o of req.orders) {
    if (seen.has(o.id)) rejected.push({ id: o.id, reason: "duplicate_in_request" })
    else {
      seen.add(o.id)
      unique.push(o)
    }
  }

  // 1. Read + judge everything first (throws => caller returns 500, nothing written).
  const snaps = await loadSnapshots(db, unique)
  const judged = unique.map((o) => {
    const snap = snaps.get(o.id) ?? null
    return { o, snap, v: judge(snap, req.provider) }
  })
  const riskyIds = judged.filter((j) => j.v.kind === "risky").map((j) => j.o.id)

  // 2. Typed confirmation gate for the whole request.
  if (req.riskyAck !== undefined) {
    const ack = checkRiskyAck(judged.map((j) => j.v), req.riskyAck)
    if (!ack.ok) return { status: 400, body: { error: "risky_ack_mismatch", expected: ack.expected } }
    // checkRiskyAck passes any ack when nothing is risky; an admin who typed a non-zero count saw a different set.
    if (riskyIds.length === 0 && req.riskyAck.count !== 0) return { status: 400, body: { error: "risky_ack_mismatch", expected: 0 } }
  }
  // Auto mode (no supplier) never releases a risky order, whatever the ack says.
  const riskyAccepted = req.riskyAck !== undefined && req.provider !== null

  // 3. Writes, one order at a time.
  const batchId = crypto.randomUUID()
  const queued: string[] = []
  for (const { o, snap, v } of judged) {
    if (v.kind === "blocked") {
      rejected.push({ id: o.id, reason: v.reason })
      continue
    }
    if (v.kind === "risky" && !riskyAccepted) {
      rejected.push({ id: o.id, reason: "needs_confirmation" })
      continue
    }

    const { table, statusCol } = ORDER_TABLES[o.type]
    let released = false
    if (v.kind === "risky") {
      // Only reached with an explicit supplier: risky orders are never released in auto mode (riskyAccepted is
      // false when provider is null, and a riskyAck without a provider is refused up front), so every released
      // order is queued hard-pinned to req.provider.
      // Known window: the order was judged from the snapshot above, and there is no cross-table transaction
      // between that read and this release, so a held order's supplier state could change in between. The guard
      // below only re-checks the order status. This is covered operationally by the typed confirmation ("I checked
      // these at the supplier") and that hard pin.
      const { data, error } = await db
        .from(table)
        .update({ [statusCol]: "pending" })
        .eq("id", o.id)
        .in(statusCol, [snap!.status])
        .select("id")
      if (error) {
        console.error(`[ENQUEUE] release failed for order ${o.id}: ${error.message}`)
        rejected.push({ id: o.id, reason: "update_failed" })
        continue
      }
      if (!data || data.length === 0) {
        rejected.push({ id: o.id, reason: "changed" })
        continue
      }
      released = true
    }

    const { error: insErr } = await db
      .from("fulfillment_queue")
      .insert({ batch_id: batchId, order_id: o.id, order_type: o.type, provider: req.provider })
    if (insErr) {
      const reason = insErr.code === "23505" ? "already_queued" : "insert_failed"
      if (reason === "insert_failed") console.error(`[ENQUEUE] queue insert failed for order ${o.id}: ${insErr.message}`)
      rejected.push({ id: o.id, reason })
      // On already_queued another request owns a live queue row for this order: leave it pending (reverting
      // would leave a queued order non-pending). For any other failure, put the risky marker back so the
      // order is not later mistaken for a plain pending one.
      if (released && reason !== "already_queued") {
        const { error: revErr } = await db
          .from(table)
          .update({ [statusCol]: snap!.status })
          .eq("id", o.id)
          .eq(statusCol, "pending")
        if (revErr) console.error(`[ENQUEUE] could not restore status of order ${o.id}: ${revErr.message}`)
      }
      continue
    }
    queued.push(o.id)
  }

  // 4. Audit row (ids only). A failure here must not hide what was queued.
  const supplier = req.provider ?? "auto"
  const { error: logErr } = await db.from("admin_bulk_send_log").insert({
    admin_id: adminId,
    supplier,
    batch_id: batchId,
    accepted_ids: queued,
    rejected,
    risky_ids: riskyIds,
  })
  if (logErr) console.error(`[ENQUEUE] send log write failed for batch ${batchId}: ${logErr.message}`)

  console.log(`[ENQUEUE] batch ${batchId} supplier=${supplier} queued=${queued.length} rejected=${rejected.length} risky=${riskyIds.length}`)
  return { status: 200, body: { batchId, queued, rejected, risky: riskyIds } }
}
