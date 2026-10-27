import { retryDecision, type LedgerFact } from "@/lib/bills/admin"
import { bundleCanDispatch, isStuckClaim } from "./admin"

export interface BundleDispatchOrder {
  id: string; reference_code: string; status: string; payment_status: string
  hubtel_client_reference: string | null; notes: string | null; updated_at: string
}

export interface BundleDispatchDeps {
  getOrder(id: string): Promise<BundleDispatchOrder | null>
  getLedger(orderId: string): Promise<LedgerFact[]>
  /** Guarded processing -> pending for a stuck "Dispatching" claim; rows changed. */
  releaseStuckClaim(orderId: string): Promise<number>
  /** Guarded pending -> processing (ref when known); rows changed. Undoes a release. */
  restoreProcessing(orderId: string, ref: string | null): Promise<number>
  /** The service's bundle dispatch (claims pending -> processing atomically); returns the resulting status. */
  dispatch(order: BundleDispatchOrder): Promise<string>
  alert(message: string, urgent?: boolean): Promise<void>
  now(): number
}

export interface BundleDispatchResult { ok: boolean; status: number; message: string; released?: boolean; orderStatus?: string }

const safeAlert = async (d: { alert(m: string, urgent?: boolean): Promise<void> }, m: string, urgent = false) => { try { await d.alert(m, urgent) } catch { /* never break the flow */ } }

/**
 * Send a paid standard bundle order that was never sent to Hubtel (no Hubtel transaction exists at all).
 * Double-delivery guard: ANY ledger row blocks it (the ledger row is written before the POST); a stuck claim is
 * released only after the ledger is proven empty, and re-checked after the release. The dispatch itself claims
 * pending -> processing atomically, so two admins clicking at once cannot both send.
 */
export async function executeBundleDispatch(d: BundleDispatchDeps, orderId: string): Promise<BundleDispatchResult> {
  let order = await d.getOrder(orderId)
  if (!order) return { ok: false, status: 404, message: "Order not found" }
  let ledger: LedgerFact[]
  try { ledger = await d.getLedger(orderId) } catch { return { ok: false, status: 503, message: "Could not read the Hubtel ledger; try again" } }
  if (ledger.length > 0) {
    return { ok: false, status: 409, message: "A Hubtel transaction already exists for this order; resolve it in Hubtel Commission (or use Retry if it failed) instead of dispatching" }
  }

  let released = false
  if (isStuckClaim(order, d.now())) {
    if ((await d.releaseStuckClaim(orderId)) === 0) return { ok: false, status: 409, message: "Claim is no longer stuck" }
    released = true
    const rows = await d.getLedger(orderId).catch(() => null)
    if (rows === null || rows.length > 0) {
      const ref = rows?.[0]?.client_reference ?? null
      let back = 0
      try { back = await d.restoreProcessing(orderId, ref) } catch { back = 0 }
      await safeAlert(d, back === 0
        ? `URGENT: standard bundle order ${order.reference_code} (${orderId}) had its stuck claim released, a Hubtel transaction${ref ? ` (${ref})` : " may have"} appeared, and it could NOT be put back to processing. Fix by hand; do not resend.`
        : `Standard bundle order ${order.reference_code}: a Hubtel transaction${ref ? ` (${ref})` : ""} appeared while releasing a stuck claim. Dispatch aborted; order restored to processing.`, back === 0)
      return { ok: false, status: back === 0 ? 500 : 409, message: "A Hubtel transaction appeared for this order (or the ledger could not be read). Dispatch aborted; check Hubtel Commission.", released }
    }
    order = await d.getOrder(orderId)
    if (!order) return { ok: false, status: 404, message: "Order not found", released }
  }
  // After a release the row is pending with a fresh updated_at by design: the grace window only guards orders we did not just release.
  const sendable = released ? order.status === "pending" && order.payment_status === "paid" && !order.hubtel_client_reference : bundleCanDispatch(order, 0, d.now())
  if (!sendable) {
    const young = order.status === "pending" && order.payment_status === "paid" && !order.hubtel_client_reference
    return { ok: false, status: 409, released, message: young
      ? "This order was updated moments ago and may still be dispatching; try again in a minute"
      : "Only paid, pending orders that were never sent can be dispatched" }
  }
  const status = await d.dispatch(order)
  const ok = status === "processing" || status === "completed"
  return { ok, status: 200, orderStatus: status, released, message: status === "pending" ? "The order is still pending; check its notes before trying again" : ok ? `Dispatched; order is ${status}` : `Dispatch did not go through; order is ${status}. Use Retry or refund it.` }
}

export interface BundleRetryOrder {
  id: string; reference_code: string; status: string; payment_status: string
  notes?: string | null; failure_reason?: string | null; updated_at: string
}

export interface BundleRetryDeps {
  getOrder(id: string): Promise<BundleRetryOrder | null>
  getLedger(orderId: string): Promise<LedgerFact[]>
  /** Guarded failed -> pending, clearing the old Hubtel reference; rows changed. */
  reopen(orderId: string, note: string): Promise<number>
  /** Guarded pending -> failed; rows changed. Undoes reopen, restoring the failure reason reopen cleared (when given). */
  revertToFailed(orderId: string, note: string, failureReason?: string | null): Promise<number>
  /** The service's bundle dispatch (claims pending -> processing atomically); returns the resulting status. */
  dispatch(order: BundleRetryOrder): Promise<string>
  alert(message: string, urgent?: boolean): Promise<void>
  now(): number
}

export interface BundleRetryResult { ok: boolean; status: number; message: string; orderStatus?: string }

/**
 * Re-send a paid standard bundle order Hubtel failed. Each attempt is a new Hubtel transaction with a new client reference.
 * Refund safety: a wallet refund claims the ledger row BEFORE it credits, and only credits a 'failed' order; so after
 * reopening we re-read the ledger, and any claim that appeared means a refund may be crediting: put the order back.
 * A storefront refund (reserve RPC) locks the order row and moves it to 'refunding', which the dispatch claim loses to.
 * Port of executeBillRetry (lib/bills/admin-dispatch.ts); the decision rules are shared via retryDecision.
 */
export async function executeBundleRetry(d: BundleRetryDeps, orderId: string): Promise<BundleRetryResult> {
  const order = await d.getOrder(orderId)
  if (!order) return { ok: false, status: 404, message: "Order not found" }
  let ledger: LedgerFact[]
  try { ledger = await d.getLedger(orderId) } catch { return { ok: false, status: 503, message: "Could not read the Hubtel ledger; try again" } }
  const decision = retryDecision(order, ledger)
  if (!decision.ok) return { ok: false, status: 409, message: decision.reason }

  if ((await d.reopen(orderId, `Retrying after Hubtel failure: ${order.failure_reason ?? "unknown reason"}`)) === 0) {
    return { ok: false, status: 409, message: "The order changed; reload and try again" }
  }
  const after = await d.getLedger(orderId).catch(() => null)
  if (after === null || !retryDecision({ status: "failed", payment_status: "paid" }, after).ok) {
    let back = 0
    try { back = await d.revertToFailed(orderId, order.notes ?? "Retry aborted", order.failure_reason ?? null) } catch { back = 0 }
    if (back === 0) {
      try { await d.alert(`URGENT: standard bundle order ${order.reference_code} (${orderId}) was reopened for a retry while a refund or Hubtel transaction appeared, and could NOT be put back to failed. Check it by hand; do not resend or refund until resolved.`, true) } catch { /* never break the flow */ }
      return { ok: false, status: 500, message: "A refund or Hubtel transaction appeared during the retry and the order could not be restored. Admins were alerted." }
    }
    return { ok: false, status: 409, message: "A refund or Hubtel transaction appeared for this order (or the ledger could not be read). Retry cancelled." }
  }

  // The order is now pending: a failed re-read must not leave it stranded there (pending can be neither sent nor refunded).
  const fresh = await d.getOrder(orderId).catch(() => null)
  if (!fresh) {
    let back = 0
    try { back = await d.revertToFailed(orderId, order.notes ?? "Retry aborted", order.failure_reason ?? null) } catch { back = 0 }
    if (back === 0) {
      try { await d.alert(`URGENT: standard bundle order ${order.reference_code} (${orderId}) was reopened for a retry but could not be re-read, and could NOT be put back to failed. Check it by hand; do not resend or refund until resolved.`, true) } catch { /* never break the flow */ }
      return { ok: false, status: 500, message: "The order could not be re-read during the retry and could not be restored. Admins were alerted." }
    }
    return { ok: false, status: 503, message: "Could not re-read the order; retry cancelled" }
  }
  const status = await d.dispatch(fresh)
  if (status === "pending") {
    // Not sent (nothing reached Hubtel). Pending + only failed ledger rows can be neither dispatched nor refunded,
    // so put it back to failed: the admin can retry again or refund.
    const cur = await d.getOrder(orderId).catch(() => null)
    const why = cur?.notes ?? "unknown reason"
    let back = 0
    try { back = await d.revertToFailed(orderId, `Retry not sent: ${why}`, order.failure_reason ?? null) } catch { back = 0 }
    if (back === 0) {
      try { await d.alert(`Standard bundle order ${order.reference_code} (${orderId}): a retry was not sent and the order could not be put back to failed. Check it in Standard Bundles.`) } catch { /* never break the flow */ }
    }
    return { ok: false, status: 200, orderStatus: back === 0 ? "pending" : "failed", message: `Retry not sent: ${why}` }
  }
  const ok = status === "processing" || status === "completed"
  return { ok, status: 200, orderStatus: status, message: ok ? `Retried; order is ${status}` : `Retry did not go through; order is ${status}` }
}
