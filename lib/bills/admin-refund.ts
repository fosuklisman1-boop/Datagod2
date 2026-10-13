import { refundDecision, type LedgerFact, type RefundOrderFacts } from "./admin"

export interface RefundOrder extends RefundOrderFacts { id: string; reference_code: string }

export interface BillRefundDeps {
  getOrder(id: string): Promise<RefundOrder | null>
  getLedger(orderId: string): Promise<LedgerFact[]>
  /** Guarded update pending -> failed; returns rows changed. */
  markFailed(orderId: string, note: string): Promise<number>
  /** Phase 1 adminRefund (claims the ledger row first). */
  refundViaLedger(ref: string, force: boolean): Promise<{ ok: boolean; message: string }>
  /** Bill adapter refundToWallet with an idempotent credit reference. Throws on outcome-unknown errors. */
  refundDirect(order: RefundOrder): Promise<{ refunded: boolean; message: string }>
  alert(message: string): Promise<void>
  now(): number
}

export interface BillRefundResult { ok: boolean; status: number; message: string; mode?: "ledger" | "direct" }

const safe = async (d: BillRefundDeps, m: string) => { try { await d.alert(m) } catch { /* never break the flow */ } }

/** The refund route's decision flow, with all IO injected. */
export async function executeBillRefund(d: BillRefundDeps, orderId: string, note: string, force: boolean): Promise<BillRefundResult> {
  const order = await d.getOrder(orderId)
  if (!order) return { ok: false, status: 404, message: "Order not found" }
  let ledger: LedgerFact[]
  try { ledger = await d.getLedger(orderId) } catch { return { ok: false, status: 503, message: "Could not read the Hubtel ledger; try again" } }
  const decision = refundDecision(order, ledger, d.now())
  if (decision.action === "blocked") return { ok: false, status: 409, message: decision.reason }

  if (decision.action === "ledger") {
    if (decision.needsForce && !force) {
      return { ok: false, status: 409, message: "This Hubtel row was marked failed by an admin override. Confirm the override to refund anyway." }
    }
    const r = await d.refundViaLedger(decision.ref, force)
    return { ok: r.ok, status: r.ok ? 200 : 409, message: r.message, mode: "ledger" }
  }

  // Never reached Hubtel: flip pending -> failed (guarded), then re-check that no ledger row appeared meanwhile.
  if (decision.markFailedFirst) {
    const n = await d.markFailed(orderId, `Admin refund: never sent to Hubtel. ${note}`)
    if (n === 0) return { ok: false, status: 409, message: "The order changed while refunding; reload and retry" }
    let after: LedgerFact[]
    try { after = await d.getLedger(orderId) } catch { after = [{ client_reference: "unknown", state: "needs_review", refund_claimed_at: null, resolved_by: null, created_at: new Date(d.now()).toISOString() }] }
    if (after.length > 0) {
      await safe(d, `Bill order ${order.reference_code}: a Hubtel transaction appeared while an admin refund was starting. Refund aborted; reconcile manually.`)
      return { ok: false, status: 409, message: "A Hubtel transaction appeared for this order while refunding. The refund was aborted; check Hubtel Commission." }
    }
  }
  const fresh = await d.getOrder(orderId)
  if (!fresh) return { ok: false, status: 404, message: "Order not found" }
  try {
    const r = await d.refundDirect(fresh)
    return { ok: r.refunded, status: r.refunded ? 200 : 409, message: r.message, mode: "direct" }
  } catch (e: any) {
    return { ok: false, status: 502, message: `Refund outcome UNKNOWN (${e?.message ?? e}). Check the customer's wallet before any retry; the credit is idempotent, so retrying is safe.`, mode: "direct" }
  }
}
