// lib/ussd-hubtel/wallet-pay.ts
// Pay a Hubtel main-code order from the caller's wallet. pay_hubtel_order_from_wallet (migration 0159) debits the wallet
// and writes one hubtel_wallet_payments row in one transaction, and does not touch the order. The order's existing
// post-payment handler (createOrderHandlers) then marks it paid and delivers. A sweep recovers a process death in between.
//
// hubtel_wallet_payments is readable and updatable here, never insertable or deletable: only the RPC inserts.
// Alerts and logs carry the order id, table, amount and a reason category only: never a phone or raw database detail.
import type { SupabaseClient } from "@supabase/supabase-js"
import { safeDbError } from "./log-safe"
import type { OrderHandlers } from "./payment"

const LOG = "[HUBTEL-WALLET]"
const TABLE = "hubtel_wallet_payments"
const ROW_COLUMNS = "id, session_id, order_table, order_id, user_id, amount, state, review_reason, created_at, updated_at"

export type WalletTable = "ussd_orders" | "airtime_orders" | "results_checker_orders" | "results_check_requests"

export const WALLET_SOURCE: Record<WalletTable, string> = {
  ussd_orders: "ussd_data_purchase",
  airtime_orders: "airtime_purchase",
  results_checker_orders: "ussd_results_checker",
  results_check_requests: "results_check_request",
}

/**
 * The live run and the sweep can only meet on a row older than this. If they did, the handler's own guarded mark stops a
 * second delivery, and the guarded state moves below stop either overwriting the other. This relies on the interaction
 * route's run time (post-payment included, when it is deferred) staying under this 10-minute window.
 */
export const WALLET_SWEEP_MIN_AGE_MS = 10 * 60_000
/**
 * A sweep claims a row by moving its updated_at (compare-and-set), and a row claimed less than this long ago is not
 * listed again. So an overlapping cron run (the route runs every 2 minutes for up to 300 seconds) never runs a handler
 * on a row another run is still handling: results_check_requests has no guarded mark of its own and would deliver twice.
 * Must stay above the route's maxDuration; a run that died mid-row frees the row after this long.
 */
export const WALLET_SWEEP_LEASE_MS = 10 * 60_000
export const WALLET_SWEEP_LIMIT = 100

export type WalletAlert = (message: string) => Promise<void>

export interface WalletPayDeps {
  db: SupabaseClient
  handlers: OrderHandlers
  alert: WalletAlert
}

export interface WalletPaymentRow {
  id: string
  session_id: string
  order_table: string
  order_id: string
  user_id: string
  amount: number | string
  state: "debited" | "fulfilled" | "needs_review"
  review_reason: string | null
  created_at: string
  updated_at: string
}

export interface WalletPayInput {
  sessionId: string
  userId: string
  table: WalletTable
  orderId: string
  amount: number
  /** The wallet history text. It may carry a phone, so it goes to the RPC and nowhere else. */
  description: string
}

export interface WalletPayResult {
  /**
   * paid: debited; the caller runs runWalletPostPayment. replay: this session already paid for this order, and that run
   * owns post-payment. insufficient / refused: nothing was debited. unavailable: see debitUncertain.
   */
  kind: "paid" | "replay" | "insufficient" | "refused" | "unavailable"
  paymentId?: string
  /**
   * Only on unavailable: the payment could not be read back, so a debit may exist. The order must be left for the sweep,
   * not failed. Without this flag, unavailable means no payment row was found.
   */
  debitUncertain?: true
}

/** Fixed RPC errors that say nothing was written. The RPC raises exactly these as the message. */
const REFUSALS = new Set(["BAD_INPUT", "ALREADY_CARTED"])

/** safeDbError, plus any long digit run (a phone) taken out of a message we did not write. */
function safeError(e: unknown): { code?: string; message: string } {
  const safe = safeDbError(e)
  return { ...safe, message: safe.message.replace(/\+?\d{9,}/g, "[number]") }
}

const ghs = (amount: number | string | null | undefined) => {
  const n = Number(amount)
  return amount != null && Number.isFinite(n) ? ` (GHS ${n.toFixed(2)})` : ""
}

/** An alert failure must never change the outcome of a payment. */
async function sendAlert(alert: WalletAlert, message: string): Promise<void> {
  try {
    await alert(message)
  } catch (e) {
    console.error(LOG, "urgent alert failed:", safeError(e))
  }
}

/** The payment row for a session, or null. THROWS on a read failure: an unread row is never the same as no payment. */
export async function findWalletPaymentBySession(db: SupabaseClient, sessionId: string): Promise<WalletPaymentRow | null> {
  const { data, error } = await db.from(TABLE).select(ROW_COLUMNS).eq("session_id", sessionId).maybeSingle()
  if (error) throw new Error(`${TABLE} read failed: ${safeError(error).message}`)
  return (data as WalletPaymentRow | null) ?? null
}

/** Debit the wallet for one order. Never runs post-payment, and never throws. */
export async function payFromWallet(deps: WalletPayDeps, input: WalletPayInput): Promise<WalletPayResult> {
  const { sessionId, userId, table, orderId, amount, description } = input
  let failure: unknown
  try {
    const { data, error } = await deps.db.rpc("pay_hubtel_order_from_wallet", {
      p_session: sessionId,
      p_user: userId,
      p_table: table,
      p_order: orderId,
      p_amount: amount,
      p_source: WALLET_SOURCE[table],
      p_description: description,
    })
    const paymentId: unknown = data?.payment_id
    if (!error && typeof paymentId === "string" && paymentId) {
      return { kind: data.replay === true ? "replay" : "paid", paymentId }
    }
    failure = error ?? new Error("RPC returned no payment id")
  } catch (e) {
    failure = e
  }

  const message = (failure as { message?: unknown } | null)?.message
  if (message === "INSUFFICIENT_FUNDS") return { kind: "insufficient" }
  if (typeof message === "string" && REFUSALS.has(message)) {
    console.warn(LOG, "payment refused:", message, table, orderId, sessionId)
    return { kind: "refused" }
  }

  // Outcome unknown: the debit may have committed. The payment row is the only witness.
  console.error(LOG, "RPC outcome unknown, reading the payment back:", table, orderId, sessionId, safeError(failure))
  let row: WalletPaymentRow | null
  try {
    row = await findWalletPaymentBySession(deps.db, sessionId)
  } catch (e) {
    console.error(LOG, "payment read-back failed:", table, orderId, sessionId, safeError(e))
    await sendAlert(deps.alert, `URGENT: wallet payment on ${table} order ${orderId}${ghs(amount)}: the debit could not be confirmed. Check the wallet and the order; the order is left for the sweep.`)
    return { kind: "unavailable", debitUncertain: true }
  }
  if (!row) return { kind: "unavailable" }
  // The session's payment may be for another order: it must never make this one look paid.
  if (row.order_table === table && row.order_id === orderId && row.user_id === userId) return { kind: "paid", paymentId: row.id }
  console.warn(LOG, "session holds a payment for another order; refused:", table, orderId, sessionId)
  return { kind: "refused" }
}

/** Move a row out of 'debited' only, so a sweep and a live run cannot overwrite each other. `row` is null if not moved. */
async function moveFromDebited(
  db: SupabaseClient,
  paymentId: string,
  patch: { state: "fulfilled" } | { state: "needs_review"; review_reason: string },
): Promise<{ ok: boolean; row: { amount: number | string } | null }> {
  try {
    const { data, error } = await db
      .from(TABLE)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", paymentId)
      .eq("state", "debited")
      .select("id, amount")
    if (error) {
      console.error(LOG, "state write failed:", paymentId, patch.state, safeError(error))
      return { ok: false, row: null }
    }
    return { ok: true, row: (data as { amount: number | string }[] | null)?.[0] ?? null }
  } catch (e) {
    console.error(LOG, "state write failed:", paymentId, patch.state, safeError(e))
    return { ok: false, row: null }
  }
}

type SettleOutcome = "fulfilled" | "review" | "none"

/** The shared post-payment step. A handler finding its order already completed returns normally: that counts as fulfilled. */
async function settle(
  deps: WalletPayDeps, paymentId: string, table: string, orderId: string, amount?: number | string,
): Promise<SettleOutcome> {
  let failure: { category: string; reason: string } | null = null
  const handler = deps.handlers[table]
  if (typeof handler !== "function") {
    console.error(LOG, "no post-payment handler:", table, orderId, paymentId)
    failure = { category: "no handler for this table", reason: "no post-payment handler for this table" }
  } else {
    try {
      await handler(orderId)
    } catch (e) {
      const safe = safeError(e)
      console.error(LOG, "post-payment failed:", table, orderId, paymentId, safe)
      failure = { category: "post-payment error", reason: safe.message }
    }
  }

  if (!failure) {
    const moved = await moveFromDebited(deps.db, paymentId, { state: "fulfilled" })
    if (moved.ok && !moved.row) console.warn(LOG, "row already moved on; left alone:", table, orderId, paymentId)
    // A failed write leaves the row debited: the sweep re-runs the handler, which returns early, and fulfils it then.
    return moved.row ? "fulfilled" : "none"
  }

  const moved = await moveFromDebited(deps.db, paymentId, { state: "needs_review", review_reason: failure.reason })
  if (moved.ok && !moved.row) {
    // Another run already moved this row: it fulfilled the order, or it raised the alert itself.
    console.warn(LOG, "post-payment failed on a row already moved on; left alone:", table, orderId, paymentId)
    return "none"
  }
  const recorded = moved.ok ? "" : " The review state could not be saved, so the sweep will try again."
  await sendAlert(deps.alert, `URGENT: wallet payment on ${table} order ${orderId}${ghs(amount ?? moved.row?.amount)}: wallet debited, but the order was not completed (${failure.category}). Check the order, then deliver it by hand or refund it to the wallet.${recorded}`)
  return "review"
}

/**
 * Run the order's handler, then set fulfilled, or needs_review with an URGENT alert naming the order. Never throws.
 * `amount` (what was debited) goes in the alert; without it, the alert takes it from the row when the write returns it.
 */
export async function runWalletPostPayment(
  deps: WalletPayDeps, paymentId: string, table: WalletTable, orderId: string, amount?: number,
): Promise<void> {
  try {
    await settle(deps, paymentId, table, orderId, amount)
  } catch (e) {
    console.error(LOG, "post-payment step failed:", table, orderId, paymentId, safeError(e))
  }
}

/**
 * Claim a listed row for this sweep run: move updated_at, only if the row is still debited and nobody moved it since it
 * was listed. False (skip the row) if another run got there first, or on any error. Never throws.
 */
async function claimRow(db: SupabaseClient, row: WalletPaymentRow): Promise<boolean> {
  try {
    const { data, error } = await db
      .from(TABLE)
      .update({ updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("state", "debited")
      .eq("updated_at", row.updated_at)
      .select("id")
    if (error) {
      console.error(LOG, "sweep claim failed; row skipped:", row.order_table, row.order_id, row.id, safeError(error))
      return false
    }
    if (!data || data.length === 0) {
      console.warn(LOG, "row claimed by another run; skipped:", row.order_table, row.order_id, row.id)
      return false
    }
    return true
  } catch (e) {
    console.error(LOG, "sweep claim failed; row skipped:", row.order_table, row.order_id, row.id, safeError(e))
    return false
  }
}

/**
 * Recover a process death after the debit: rows still 'debited' after the window go through the same post-payment step.
 * Never throws, and one row's failure does not stop the others. A failed list is logged but not alerted: the next run
 * tries again, and an alert here would repeat on every run of a long outage. `deadlineMs`: once passed, no new row is
 * started, so a handler is not killed halfway by the route's time limit; the next run picks up the rest.
 */
export async function sweepWalletPayments(
  db: SupabaseClient,
  handlers: OrderHandlers,
  alert: WalletAlert,
  now: number = Date.now(),
  deadlineMs?: number,
): Promise<{ found: number; fulfilled: number; review: number }> {
  const out = { found: 0, fulfilled: 0, review: 0 }
  try {
    const { data, error } = await db
      .from(TABLE)
      .select(ROW_COLUMNS)
      .eq("state", "debited")
      .lt("created_at", new Date(now - WALLET_SWEEP_MIN_AGE_MS).toISOString())
      .lt("updated_at", new Date(now - WALLET_SWEEP_LEASE_MS).toISOString())
      .order("created_at", { ascending: true })
      .limit(WALLET_SWEEP_LIMIT)
    if (error) {
      console.error(LOG, "sweep list failed:", safeError(error))
      return out
    }
    const rows = (data ?? []) as WalletPaymentRow[]
    out.found = rows.length
    for (const row of rows) {
      if (deadlineMs != null && Date.now() > deadlineMs) break
      try {
        if (!(await claimRow(db, row))) continue
        const outcome = await settle({ db, handlers, alert }, row.id, row.order_table, row.order_id, row.amount)
        if (outcome === "fulfilled") out.fulfilled++
        else if (outcome === "review") out.review++
      } catch (e) {
        console.error(LOG, "sweep row failed:", row.order_table, row.order_id, row.id, safeError(e))
      }
    }
  } catch (e) {
    console.error(LOG, "sweep failed:", safeError(e))
  }
  return out
}
