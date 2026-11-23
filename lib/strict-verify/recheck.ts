// The 5-minute strict re-check (strict per-supplier MTN verification).
//
// For every OPEN mtn_strict_holds row:
// - switch off: release it to today's normal (unpinned) dispatch;
// - its order no longer held_registration: close the hold (released), dispatch nothing;
// - held more than 72 h: order back to pending, hold expired (auto-fulfil never picks it), one admin push per run;
// - due (unanswered: 5 min since the last check; rejected: 24 h): ask each candidate supplier (fresh saved verdict
//   first). Any "yes" releases every open hold for that phone.
//
// Release order (never strand an order): claim the order held_registration -> pending (guarded), THEN close the hold,
// THEN dispatch. If the dispatch holds the order again, Task 4's holdMtnOrder opens a fresh hold row.
// Every hold write is guarded on its held_at, so a hold re-opened by someone else is never closed by mistake.
// Two overlapping runs are safe: only the run that wins the guarded claim dispatches.
// Logs carry ids and counts only, never a phone number.
import type { SupabaseClient } from "@supabase/supabase-js"
import { HOLD_STATUS, MTN_ORDER_TABLES, STRICT_HOLDS_TABLE, phoneColumnFor, statusColumnFor, type MtnOrderTable } from "@/lib/mtn-hold"
import { askSupplier, canCheck, type Answer } from "./ask"
import { buildCandidates } from "./send"
import { isStrictVerifyOn } from "./settings"
import { getFreshVerdicts, saveVerdicts } from "./verdicts"

export const RECHECK_LIMIT = 500
export const EXPIRE_AFTER_MS = 72 * 3_600_000
export const UNANSWERED_EVERY_MS = 5 * 60_000
export const REJECTED_EVERY_MS = 24 * 3_600_000
/** No new phone is checked after this much real time (the route's maxDuration is 300 s). */
const RUN_BUDGET_MS = 240_000
/** Hubnet's rate limit trips a shared cooldown that also blocks live sends: cap its asks per run. */
export const HUBNET_ASKS_PER_RUN = 8
const CHUNK = 100
const TAG = "[STRICT-RECHECK]"

export type StrictHoldRow = {
  order_table: MtnOrderTable
  order_id: string
  phone: string
  reason: "rejected" | "unanswered"
  state: string
  held_at: string
  last_checked_at: string | null
}

export type RecheckSummary = { checked: number; released: number; expired: number; stillHeld: number }

const key = (h: { order_table: string; order_id: string }) => `${h.order_table}/${h.order_id}`
const isUssd = (t: MtnOrderTable): t is "ussd_orders" | "ussd_shop_orders" => t === "ussd_orders" || t === "ussd_shop_orders"
const orderTypeFor = (t: MtnOrderTable): "bulk" | "shop" | "api" => (t === "orders" ? "bulk" : t === "api_orders" ? "api" : "shop")
const errCode = (e: unknown) => (e && typeof e === "object" && "code" in e ? String((e as { code?: unknown }).code ?? "error") : "error")
const ms = (at: string | null | undefined) => {
  const t = at ? Date.parse(at) : NaN
  return Number.isNaN(t) ? null : t
}

function parseHolds(data: unknown): StrictHoldRow[] {
  const out: StrictHoldRow[] = []
  for (const r of (Array.isArray(data) ? data : []) as any[]) {
    if (!r || !MTN_ORDER_TABLES.includes(r.order_table) || !r.order_id || r.state !== "open") continue
    out.push({
      order_table: r.order_table,
      order_id: String(r.order_id),
      phone: String(r.phone ?? ""),
      reason: r.reason === "rejected" ? "rejected" : "unanswered",
      state: "open",
      held_at: String(r.held_at ?? ""),
      last_checked_at: r.last_checked_at ?? null,
    })
  }
  return out
}

const HOLD_COLS = "order_table, order_id, phone, reason, state, held_at, last_checked_at"

/** A guarded write to one hold row: only while it is still the same open hold episode. */
function holdWhereOpen(db: SupabaseClient, values: Record<string, unknown>, h: StrictHoldRow) {
  return db
    .from(STRICT_HOLDS_TABLE)
    .update(values)
    .eq("order_table", h.order_table)
    .eq("order_id", h.order_id)
    .eq("state", "open")
    .eq("held_at", h.held_at)
}

/** Guarded held_registration -> to. "claimed" | "not_held" (0 rows) | "error". */
async function moveOrder(db: SupabaseClient, h: StrictHoldRow, to: string): Promise<"claimed" | "not_held" | "error"> {
  const col = statusColumnFor(h.order_table)
  try {
    const { data, error } = await db
      .from(h.order_table)
      .update({ [col]: to, updated_at: new Date().toISOString() })
      .eq("id", h.order_id)
      .eq(col, HOLD_STATUS)
      .select("id")
    if (error) {
      console.error(`${TAG} order claim failed for ${key(h)}:`, errCode(error))
      return "error"
    }
    return Array.isArray(data) && data.length > 0 ? "claimed" : "not_held"
  } catch {
    console.error(`${TAG} order claim threw for ${key(h)}`)
    return "error"
  }
}

/**
 * The order is no longer held: close its hold (released) with no dispatch. Then re-read the order: if it was held
 * again in between (a send elsewhere re-used this still-open hold), re-open it, so a held order always has an open hold.
 */
async function closeMovedOn(db: SupabaseClient, h: StrictHoldRow, now: Date): Promise<boolean> {
  const closedAt = now.toISOString()
  const { error } = await holdWhereOpen(db, { state: "released", closed_at: closedAt }, h)
  if (error) {
    console.error(`${TAG} closing hold failed for ${key(h)}:`, errCode(error))
    return false
  }
  try {
    const col = statusColumnFor(h.order_table)
    const { data, error: readErr } = await db.from(h.order_table).select(`id, ${col}`).eq("id", h.order_id).maybeSingle()
    if (!readErr && data && (data as Record<string, unknown>)[col] === HOLD_STATUS) {
      await db
        .from(STRICT_HOLDS_TABLE)
        .update({ state: "open", closed_at: null })
        .eq("order_table", h.order_table)
        .eq("order_id", h.order_id)
        .eq("state", "released")
        .eq("held_at", h.held_at)
        .eq("closed_at", closedAt)
      console.warn(`${TAG} ${key(h)} was held again while closing: hold kept open`)
      return false
    }
  } catch {
    // The close stands; nothing order-specific to log beyond the id.
    console.warn(`${TAG} re-read after closing ${key(h)} failed`)
  }
  return true
}

async function dispatch(db: SupabaseClient, h: StrictHoldRow): Promise<"sent" | "failed"> {
  try {
    if (isUssd(h.order_table)) {
      const phoneCol = phoneColumnFor(h.order_table)
      const { data, error } = await db
        .from(h.order_table)
        .select(`id, network, package_size, ${phoneCol}`)
        .eq("id", h.order_id)
        .maybeSingle()
      if (error || !data) {
        // The order stays pending (today's normal flows pick it up).
        console.error(`${TAG} order read for dispatch failed for ${key(h)}`)
        return "failed"
      }
      const row = data as Record<string, any>
      const { fulfillUssdOrder } = await import("@/lib/ussd/fulfill")
      const res = await fulfillUssdOrder(
        h.order_id,
        row.network ?? "MTN",
        String(row[phoneCol] ?? ""),
        row.package_size ?? "",
        false,
        h.order_table,
      )
      return res.success ? "sent" : "failed"
    }
    const { processManualFulfillment } = await import("@/lib/fulfillment-service")
    const res = await processManualFulfillment(h.order_id, orderTypeFor(h.order_table))
    return res.success ? "sent" : "failed"
  } catch {
    console.error(`${TAG} dispatch threw for ${key(h)}`)
    return "failed"
  }
}

/** Claim -> close -> dispatch (unpinned). */
async function releaseHold(db: SupabaseClient, h: StrictHoldRow, now: Date): Promise<"released" | "closed" | "kept"> {
  const claim = await moveOrder(db, h, "pending")
  if (claim === "error") return "kept"
  if (claim === "not_held") return (await closeMovedOn(db, h, now)) ? "closed" : "kept"
  const { error } = await holdWhereOpen(db, { state: "released", closed_at: now.toISOString() }, h)
  // The order is pending now either way; an open row left behind is closed by the next run (order not held).
  if (error) console.error(`${TAG} closing released hold failed for ${key(h)}:`, errCode(error))
  const sent = await dispatch(db, h)
  console.log(`${TAG} released ${key(h)} dispatch=${sent}`)
  return "released"
}

/** Order back to pending (guarded), hold expired. If the expired mark cannot be written, the order is held again. */
async function expireHold(db: SupabaseClient, h: StrictHoldRow, now: Date): Promise<"expired" | "closed" | "kept"> {
  const claim = await moveOrder(db, h, "pending")
  if (claim === "error") return "kept"
  if (claim === "not_held") return (await closeMovedOn(db, h, now)) ? "closed" : "kept"
  const closedAt = now.toISOString()
  const { data: written, error } = await holdWhereOpen(db, { state: "expired", closed_at: closedAt }, h).select("order_id")
  let wrote = !error && Array.isArray(written) && written.length > 0
  if (!error && !wrote) {
    // An overlapping run's closeMovedOn may have marked this same hold episode released between our claim and now.
    // We own the order (the claim succeeded), so the episode ends expired.
    const { data: again, error: againErr } = await db
      .from(STRICT_HOLDS_TABLE)
      .update({ state: "expired", closed_at: closedAt })
      .eq("order_table", h.order_table)
      .eq("order_id", h.order_id)
      .eq("state", "released")
      .eq("held_at", h.held_at)
      .select("order_id")
    wrote = !againErr && Array.isArray(again) && again.length > 0
  }
  if (!wrote) {
    // A pending order with an open hold would be closed as "released" later and picked up by auto-fulfil: put it back.
    console.error(`${TAG} expiring hold failed for ${key(h)}:`, error ? errCode(error) : "no row matched")
    const col = statusColumnFor(h.order_table)
    const { error: backErr } = await db
      .from(h.order_table)
      .update({ [col]: HOLD_STATUS, updated_at: new Date().toISOString() })
      .eq("id", h.order_id)
      .eq(col, "pending")
    if (backErr) console.error(`${TAG} could not hold ${key(h)} again after a failed expiry`)
    return "kept"
  }
  return "expired"
}

/** Current status per loaded hold (keyed table/id). A table whose read fails is left out (its holds are untouched). */
async function readStatuses(db: SupabaseClient, holds: StrictHoldRow[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  for (const table of MTN_ORDER_TABLES) {
    const ids = holds.filter((h) => h.order_table === table).map((h) => h.order_id)
    const col = statusColumnFor(table)
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      try {
        const { data, error } = await db.from(table).select(`id, ${col}`).in("id", chunk)
        if (error) {
          console.error(`${TAG} status read failed for ${table}:`, errCode(error))
          continue
        }
        const found = new Map<string, string>()
        for (const r of (data ?? []) as any[]) found.set(String(r.id), String(r[col] ?? ""))
        // A missing order row reads as "not held".
        for (const id of chunk) out.set(`${table}/${id}`, found.get(id) ?? null)
      } catch {
        console.error(`${TAG} status read threw for ${table}`)
      }
    }
  }
  return out
}

function isDue(h: StrictHoldRow, now: Date): boolean {
  const last = ms(h.last_checked_at) ?? ms(h.held_at)
  if (last === null) return true
  const every = h.reason === "rejected" ? REJECTED_EVERY_MS : UNANSWERED_EVERY_MS
  return now.getTime() - last >= every
}

/**
 * One run. Loads up to 500 open holds, oldest last check first (never checked first).
 * Never throws for a single hold; a failed hold load returns zeros.
 */
export async function runStrictRecheck(db: SupabaseClient, now: Date): Promise<RecheckSummary> {
  const summary: RecheckSummary = { checked: 0, released: 0, expired: 0, stillHeld: 0 }
  const started = Date.now()

  const { data, error } = await db
    .from(STRICT_HOLDS_TABLE)
    .select(HOLD_COLS)
    .eq("state", "open")
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(RECHECK_LIMIT)
  if (error) {
    console.error(`${TAG} loading holds failed:`, errCode(error))
    return summary
  }
  const holds = parseHolds(data).sort((a, b) => (ms(a.last_checked_at) ?? -Infinity) - (ms(b.last_checked_at) ?? -Infinity))
  if (holds.length === 0) return summary

  const closed = new Set<string>()
  const tally = (h: StrictHoldRow, outcome: "released" | "expired" | "closed" | "kept") => {
    if (outcome === "kept") return
    closed.add(key(h))
    if (outcome === "released") summary.released++
    if (outcome === "expired") summary.expired++
  }

  // Switch off: every open hold goes back to today's normal dispatch.
  if (!(await isStrictVerifyOn(db))) {
    for (const h of holds) {
      if (Date.now() - started >= RUN_BUDGET_MS) break // leftovers stay open for the next run
      tally(h, await releaseHold(db, h, now))
    }
    summary.stillHeld = holds.filter((h) => !closed.has(key(h))).length
    console.log(`${TAG} switch off: released=${summary.released} kept=${summary.stillHeld}`)
    return summary
  }

  // 1. Orders that moved on; 2. expiry. Holds whose status could not be read are left alone.
  const statuses = await readStatuses(db, holds)
  const due: StrictHoldRow[] = []
  for (const h of holds) {
    if (!statuses.has(key(h))) continue
    if (statuses.get(key(h)) !== HOLD_STATUS) {
      tally(h, (await closeMovedOn(db, h, now)) ? "closed" : "kept")
      continue
    }
    const heldAt = ms(h.held_at)
    if (heldAt !== null && now.getTime() - heldAt > EXPIRE_AFTER_MS) {
      tally(h, await expireHold(db, h, now))
      continue
    }
    if (isDue(h, now)) due.push(h)
  }

  // 3. Re-ask the due holds, one check per phone.
  if (due.length > 0) {
    let candidates: string[] = []
    let ready = true
    try {
      const built = await buildCandidates(db)
      candidates = built.candidates.filter((s) => canCheck(s, built.disabled))
    } catch {
      console.error(`${TAG} candidate suppliers could not be read: no checks this run`)
      ready = false
    }

    const byPhone = new Map<string, StrictHoldRow[]>()
    for (const h of due) byPhone.set(h.phone, [...(byPhone.get(h.phone) ?? []), h])

    let hubnetStopped = false
    let hubnetAsks = 0
    for (const [phone, group] of ready ? byPhone : new Map<string, StrictHoldRow[]>()) {
      if (Date.now() - started >= RUN_BUDGET_MS) break
      summary.checked += group.length

      let fresh = new Map<string, "yes" | "no">()
      if (candidates.length > 0) {
        try {
          fresh = await getFreshVerdicts(db, phone, candidates, now)
        } catch {
          fresh = new Map()
        }
      }
      let approved = [...fresh.values()].includes("yes")
      let unanswered = false
      if (!approved) {
        for (const supplier of candidates) {
          let answer: Answer
          if (fresh.has(supplier)) answer = fresh.get(supplier)!
          else if (supplier === "hubnet" && (hubnetStopped || hubnetAsks >= HUBNET_ASKS_PER_RUN)) answer = "no_answer"
          else {
            if (supplier === "hubnet") hubnetAsks++
            try {
              answer = await askSupplier(supplier, phone)
            } catch {
              answer = "no_answer"
            }
            if (supplier === "hubnet" && answer === "no_answer") hubnetStopped = true
            if (answer === "yes" || answer === "no") {
              try {
                await saveVerdicts(db, [{ phone, supplier, verdict: answer }], now)
              } catch {
                console.error(`${TAG} saving a verdict failed (ids only)`)
              }
            }
          }
          if (answer === "yes") {
            approved = true
            break
          }
          if (answer === "no_answer") unanswered = true
        }
      }

      if (approved) {
        // Every open hold for this phone, not only the due ones loaded here.
        let all: StrictHoldRow[] = group
        try {
          const { data: rows, error: allErr } = await db.from(STRICT_HOLDS_TABLE).select(HOLD_COLS).eq("phone", phone).eq("state", "open")
          if (!allErr) {
            const seen = new Set(group.map(key))
            all = [...group, ...parseHolds(rows).filter((r) => !seen.has(key(r)))]
          }
        } catch {
          // fall back to the due holds
        }
        for (const h of all) {
          if (closed.has(key(h))) continue
          if (Date.now() - started >= RUN_BUDGET_MS) break // leftovers stay open for the next run
          tally(h, await releaseHold(db, h, now))
        }
        continue
      }

      // Still nobody approved: record the check (guarded: same open hold episode).
      const reason = unanswered ? "unanswered" : "rejected"
      for (const h of group) {
        const { error: upErr } = await holdWhereOpen(db, { last_checked_at: now.toISOString(), reason }, h)
        if (upErr) console.error(`${TAG} recording the check failed for ${key(h)}:`, errCode(upErr))
      }
    }
  }

  // 4. One phone-free push for everything that expired this run.
  if (summary.expired > 0) {
    try {
      const { notifyAdminsPush } = await import("@/lib/push-service")
      await notifyAdminsPush({
        title: "MTN verification",
        body: `${summary.expired} MTN orders could not be verified for 72 hours — check Needs action`,
        data: { url: "/admin/order-payment-status" },
      })
    } catch {
      console.error(`${TAG} expiry push failed`)
    }
  }

  summary.stillHeld = holds.filter((h) => !closed.has(key(h))).length
  console.log(
    `${TAG} checked=${summary.checked} released=${summary.released} expired=${summary.expired} stillHeld=${summary.stillHeld}`,
  )
  return summary
}
