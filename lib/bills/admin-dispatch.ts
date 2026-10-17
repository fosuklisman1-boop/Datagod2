import { canDispatch, isStuckClaim, retryDecision, type LedgerFact, type RefundOrderFacts } from "./admin"

export interface DispatchOrder extends RefundOrderFacts {
  id: string; reference_code: string; biller?: string; created_at?: string
  /** When the account was verified (storefront orders); the sessionId's age counts from here. */
  verified_at?: string | null
  failure_reason?: string | null
}

/** The Hubtel Ghana Water sessionId is per-lookup; a paid order older than this cannot safely be sent late. */
export const GHANA_WATER_MAX_AGE_MS = 10 * 60_000

/** Start of the Ghana Water 10-minute window: COALESCE(verified_at, created_at). */
export function ghanaWaterAgeFrom(order: Pick<DispatchOrder, "verified_at" | "created_at">): string | null {
  return order.verified_at || order.created_at || null
}

export interface BillDispatchDeps {
  getOrder(id: string): Promise<DispatchOrder | null>
  getLedger(orderId: string): Promise<LedgerFact[]>
  /** Guarded processing -> pending with a "Released stuck dispatch claim" note; rows changed. */
  releaseStuckClaim(orderId: string): Promise<number>
  /** Guarded pending -> processing (ref when known); rows changed. Undoes a release. */
  restoreProcessing(orderId: string, ref: string | null): Promise<number>
  /** The service's dispatchBillOrder (claims atomically); returns the resulting status. */
  dispatch(order: DispatchOrder): Promise<string>
  alert(message: string, urgent?: boolean): Promise<void>
  now(): number
}

export interface BillDispatchResult { ok: boolean; status: number; message: string; released?: boolean; orderStatus?: string }

const safe = async (d: BillDispatchDeps, m: string, urgent = false) => { try { await d.alert(m, urgent) } catch { /* never break the flow */ } }

/** The dispatch route's decision flow with all IO injected. */
export async function executeBillDispatch(d: BillDispatchDeps, orderId: string): Promise<BillDispatchResult> {
  let order = await d.getOrder(orderId)
  if (!order) return { ok: false, status: 404, message: "Order not found" }
  let ledger: LedgerFact[]
  try { ledger = await d.getLedger(orderId) } catch { return { ok: false, status: 503, message: "Could not read the Hubtel ledger; try again" } }

  const gwFrom = ghanaWaterAgeFrom(order)
  if (order.biller === "ghana_water" && gwFrom && d.now() - Date.parse(gwFrom) > GHANA_WATER_MAX_AGE_MS &&(canDispatch(order) || isStuckClaim(order, ledger, d.now()))) {
    return { ok: false, status: 409, message: "Ghana Water verification expired — refund instead" }
  }

  let released = false
  if (isStuckClaim(order, ledger, d.now())) {
    if ((await d.releaseStuckClaim(orderId)) === 0) return { ok: false, status: 409, message: "Claim is no longer stuck" }
    released = true
    const rows = await d.getLedger(orderId).catch(() => null)
    if (rows === null || rows.length > 0) {
      const ref = rows?.[0]?.client_reference ?? null
      let back = 0
      try { back = await d.restoreProcessing(orderId, ref) } catch { back = 0 }
      await safe(d, back === 0
        ? `URGENT: bill order ${order.reference_code} (${orderId}) had its stuck claim released, a Hubtel transaction${ref ? ` (${ref})` : " may have"} appeared, and it could NOT be put back to processing. Fix by hand; do not resend.`
        : `Bill order ${order.reference_code}: a Hubtel transaction${ref ? ` (${ref})` : ""} appeared while releasing a stuck claim. Dispatch aborted; order restored to processing.`, back === 0)
      return { ok: false, status: back === 0 ? 500 : 409, message: "A Hubtel transaction appeared for this order (or the ledger could not be read). Dispatch aborted; check Hubtel Commission.", released }
    }
    order = await d.getOrder(orderId)
    if (!order) return { ok: false, status: 404, message: "Order not found", released }
  } else if (ledger.length > 0) {
    return { ok: false, status: 409, message: "A Hubtel transaction already exists for this order; resolve it in Hubtel Commission instead of dispatching" }
  }
  if (!canDispatch(order)) return { ok: false, status: 409, message: "Only paid, pending orders that were never sent can be dispatched", released }
  const status = await d.dispatch(order)
  return { ok: status !== "pending", status: 200, orderStatus: status, released, message: status === "pending" ? "The order is still pending; check its notes before trying again" : `Dispatched; order is ${status}` }
}

export interface BillRetryDeps {
  getOrder(id: string): Promise<DispatchOrder | null>
  getLedger(orderId: string): Promise<LedgerFact[]>
  /** Guarded failed -> pending, clearing the old Hubtel reference; rows changed. */
  reopen(orderId: string, note: string): Promise<number>
  /** Guarded pending -> failed; rows changed. Undoes reopen. */
  revertToFailed(orderId: string, note: string): Promise<number>
  /** The service's dispatchBillOrder (claims pending -> processing atomically); returns the resulting status. */
  dispatch(order: DispatchOrder): Promise<string>
  alert(message: string, urgent?: boolean): Promise<void>
  now(): number
}

/**
 * Re-send a paid order Hubtel failed. Each attempt is a new Hubtel transaction with a new client reference.
 * Refund safety: a wallet refund claims the ledger row BEFORE it credits, and only credits a 'failed' order; so after
 * reopening we re-read the ledger, and any claim that appeared means a refund may be crediting: put the order back.
 * A storefront refund (reserve RPC) locks the order row and moves it to 'refunding', which the dispatch claim loses to.
 */
export async function executeBillRetry(d: BillRetryDeps, orderId: string): Promise<BillDispatchResult> {
  const order = await d.getOrder(orderId)
  if (!order) return { ok: false, status: 404, message: "Order not found" }
  let ledger: LedgerFact[]
  try { ledger = await d.getLedger(orderId) } catch { return { ok: false, status: 503, message: "Could not read the Hubtel ledger; try again" } }
  const decision = retryDecision(order, ledger)
  if (!decision.ok) return { ok: false, status: 409, message: decision.reason }
  const gwFrom = ghanaWaterAgeFrom(order)
  if (order.biller === "ghana_water" && gwFrom && d.now() - Date.parse(gwFrom) > GHANA_WATER_MAX_AGE_MS) {
    return { ok: false, status: 409, message: "Ghana Water verification expired — refund instead" }
  }

  if ((await d.reopen(orderId, `Retrying after Hubtel failure: ${order.failure_reason ?? "unknown reason"}`)) === 0) {
    return { ok: false, status: 409, message: "The order changed; reload and try again" }
  }
  const after = await d.getLedger(orderId).catch(() => null)
  if (after === null || !retryDecision({ status: "failed", payment_status: "paid" }, after).ok) {
    let back = 0
    try { back = await d.revertToFailed(orderId, order.notes ?? "Retry aborted") } catch { back = 0 }
    if (back === 0) {
      try { await d.alert(`URGENT: bill order ${order.reference_code} (${orderId}) was reopened for a retry while a refund or Hubtel transaction appeared, and could NOT be put back to failed. Check it by hand; do not resend or refund until resolved.`, true) } catch { /* never break the flow */ }
      return { ok: false, status: 500, message: "A refund or Hubtel transaction appeared during the retry and the order could not be restored. Admins were alerted." }
    }
    return { ok: false, status: 409, message: "A refund or Hubtel transaction appeared for this order (or the ledger could not be read). Retry cancelled." }
  }

  const fresh = await d.getOrder(orderId)
  if (!fresh) return { ok: false, status: 404, message: "Order not found" }
  const status = await d.dispatch(fresh)
  if (status === "pending") {
    // Not sent (nothing reached Hubtel). Pending + only failed ledger rows can be neither dispatched nor refunded,
    // so put it back to failed: the admin can retry again or refund.
    const cur = await d.getOrder(orderId).catch(() => null)
    const why = cur?.notes ?? "unknown reason"
    let back = 0
    try { back = await d.revertToFailed(orderId, `Retry not sent: ${why}`) } catch { back = 0 }
    if (back === 0) {
      try { await d.alert(`Bill order ${order.reference_code} (${orderId}): a retry was not sent and the order could not be put back to failed. Check it in Utility Bills.`) } catch { /* never break the flow */ }
    }
    return { ok: false, status: 200, orderStatus: back === 0 ? "pending" : "failed", message: `Retry not sent: ${why}` }
  }
  return { ok: true, status: 200, orderStatus: status, message: `Retried; order is ${status}` }
}
