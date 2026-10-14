import { refundDecision, type LedgerFact, type RefundOrderFacts } from "./admin"

export interface RefundOrder extends RefundOrderFacts {
  id: string
  reference_code: string
  /** 'storefront' rows are refunded on /admin/refunds (the buyer has no wallet). Absent = not selected (legacy caller). */
  channel?: string | null
  /** NULL on storefront rows: no wallet to credit. */
  user_id?: string | null
}

export const STOREFRONT_BILL_REFUND_MESSAGE =
  "Storefront or bot order: the buyer has no wallet. Refund it on /admin/refunds (Paystack reversal, MoMo payout, or Mark refunded manually)."

export interface BillRefundDeps {
  getOrder(id: string): Promise<RefundOrder | null>
  getLedger(orderId: string): Promise<LedgerFact[]>
  /** Guarded update pending -> failed; returns rows changed. */
  markFailed(orderId: string, note: string): Promise<number>
  /** Guarded <from> -> processing (sets hubtel_client_reference when known); returns rows changed. Undoes markFailed / a stuck-claim release. */
  revertToProcessing(orderId: string, ref: string | null, from: "failed" | "pending"): Promise<number>
  /** Guarded processing -> pending with a "Released stuck dispatch claim" note; returns rows changed. */
  releaseStuckClaim(orderId: string): Promise<number>
  /** Phase 1 adminRefund (claims the ledger row first). */
  refundViaLedger(ref: string, force: boolean): Promise<{ ok: boolean; message: string }>
  /** Bill adapter refundToWallet with an idempotent credit reference. Throws on outcome-unknown errors. */
  refundDirect(order: RefundOrder): Promise<{ refunded: boolean; message: string }>
  alert(message: string, urgent?: boolean): Promise<void>
  now(): number
}

export interface BillRefundResult { ok: boolean; status: number; message: string; mode?: "ledger" | "direct"; released?: boolean }

const safe = async (d: BillRefundDeps, m: string, urgent = false) => { try { await d.alert(m, urgent) } catch { /* never break the flow */ } }

/** The refund route's decision flow, with all IO injected. */
export async function executeBillRefund(d: BillRefundDeps, orderId: string, note: string, force: boolean): Promise<BillRefundResult> {
  const order = await d.getOrder(orderId)
  if (!order) return { ok: false, status: 404, message: "Order not found" }
  // Checked before anything moves: never fence a storefront order to failed for a wallet refund that cannot happen.
  if (order.channel === "storefront" || order.channel === "bots" || !order.user_id) return { ok: false, status: 409, message: STOREFRONT_BILL_REFUND_MESSAGE }
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
  let released = false
  if (decision.markFailedFirst) {
    if (decision.releaseStuck) {
      if ((await d.releaseStuckClaim(orderId)) === 0) return { ok: false, status: 409, message: "Claim is no longer stuck" }
      released = true
      const rows = await d.getLedger(orderId).catch(() => null)
      if (rows === null || rows.length > 0) return { ...(await abort(d, order, orderId, rows, "pending")), released }
    }
    const n = await d.markFailed(orderId, `Admin refund: never sent to Hubtel. ${note}`)
    if (n === 0) return { ok: false, status: 409, message: "The order changed while refunding; reload and retry", released }
    const after = await d.getLedger(orderId).catch(() => null)
    if (after === null || after.length > 0) return { ...(await abort(d, order, orderId, after, "failed")), released }
  }
  const fresh = await d.getOrder(orderId)
  if (!fresh) return { ok: false, status: 404, message: "Order not found" }
  try {
    const r = await d.refundDirect(fresh)
    return { ok: r.refunded, status: r.refunded ? 200 : 409, message: r.message, mode: "direct", released }
  } catch (e: any) {
    return { ok: false, status: 502, message: `Refund outcome UNKNOWN (${e?.message ?? e}). Check the customer's wallet before any retry; the credit is idempotent, so retrying is safe.`, mode: "direct", released }
  }
}

/** A Hubtel row appeared (or the ledger could not be read) mid-refund: hand the order back to Hubtel's lifecycle. */
async function abort(d: BillRefundDeps, order: RefundOrder, orderId: string, rows: LedgerFact[] | null, from: "failed" | "pending"): Promise<BillRefundResult> {
  const ref = rows?.find(l => l.state !== "failed")?.client_reference ?? rows?.[0]?.client_reference ?? null
  let reverted = 0
  try { reverted = await d.revertToProcessing(orderId, ref, from) } catch { reverted = 0 }
  if (reverted === 0) {
    await safe(d, `URGENT: bill order ${order.reference_code} (${orderId}) was moved for a refund, a Hubtel transaction${ref ? ` (${ref})` : " may have"} appeared, and the order could NOT be restored to processing. Fix by hand; do not refund.`, true)
    return { ok: false, status: 500, message: "A Hubtel transaction appeared while refunding and the order could not be restored to processing. Admins were alerted; do not refund." }
  }
  await safe(d, `Bill order ${order.reference_code}: a Hubtel transaction${ref ? ` (${ref})` : ""} appeared (or the ledger could not be read) while an admin refund was starting. Refund aborted; order restored to processing.`)
  return { ok: false, status: 409, message: "A Hubtel transaction appeared for this order while refunding (or the ledger could not be read). The refund was aborted and the order restored to processing; check Hubtel Commission." }
}
