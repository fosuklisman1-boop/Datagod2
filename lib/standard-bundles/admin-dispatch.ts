import { retryDecision, type LedgerFact } from "@/lib/bills/admin"

export interface BundleRetryOrder {
  id: string; reference_code: string; status: string; payment_status: string
  notes?: string | null; failure_reason?: string | null; updated_at: string
}

export interface BundleRetryDeps {
  getOrder(id: string): Promise<BundleRetryOrder | null>
  getLedger(orderId: string): Promise<LedgerFact[]>
  /** Guarded failed -> pending, clearing the old Hubtel reference; rows changed. */
  reopen(orderId: string, note: string): Promise<number>
  /** Guarded pending -> failed; rows changed. Undoes reopen. */
  revertToFailed(orderId: string, note: string): Promise<number>
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
    try { back = await d.revertToFailed(orderId, order.notes ?? "Retry aborted") } catch { back = 0 }
    if (back === 0) {
      try { await d.alert(`URGENT: standard bundle order ${order.reference_code} (${orderId}) was reopened for a retry while a refund or Hubtel transaction appeared, and could NOT be put back to failed. Check it by hand; do not resend or refund until resolved.`, true) } catch { /* never break the flow */ }
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
      try { await d.alert(`Standard bundle order ${order.reference_code} (${orderId}): a retry was not sent and the order could not be put back to failed. Check it in Standard Bundles.`) } catch { /* never break the flow */ }
    }
    return { ok: false, status: 200, orderStatus: back === 0 ? "pending" : "failed", message: `Retry not sent: ${why}` }
  }
  return { ok: true, status: 200, orderStatus: status, message: `Retried; order is ${status}` }
}
