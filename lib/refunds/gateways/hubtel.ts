import { requestHubtelRefund } from "../hubtel-refund"
import { isWalletOnlyTable, WALLET_ONLY_REASON, type RefundGateway } from "../types"

// Hubtel allows refunds for 45 days from payment; stop at 44 so a clock skew or a slow admin never hits the edge.
const MAX_AGE_MS = 44 * 86_400_000
// Hubtel rejects refunds under GHS 1.00 (code 4000).
const MIN_AMOUNT = 1

export const hubtelGateway: RefundGateway = {
  id: "hubtel",
  label: "Hubtel (refund to payer)",
  supports(order) {
    if (process.env.HUBTEL_REFUND_ENABLED !== "true") return { ok: false, reason: "Hubtel refunds are not enabled" }
    if (isWalletOnlyTable(order.table)) return { ok: false, reason: WALLET_ONLY_REASON }
    const h = order.payment.hubtel
    if (!h) return { ok: false, reason: "Not paid through Hubtel" }
    // With several paid rows the other hubtel fields come from an arbitrary one, so never guess.
    if (h.paidRows !== 1) return { ok: false, reason: "This order has more than one Hubtel payment — refund manually" }
    if (!Number.isFinite(h.amountPaid) || h.amountPaid < MIN_AMOUNT) return { ok: false, reason: "Hubtel cannot refund amounts under GHS 1.00" }
    const paidAt = Date.parse(h.paidAt)
    if (!Number.isFinite(paidAt) || Date.now() - paidAt > MAX_AGE_MS) return { ok: false, reason: "Hubtel refunds are only possible within 45 days of payment" }
    return { ok: true }
  },
  fixedAmount(order) {
    return order.payment.hubtel?.amountPaid ?? null
  },
  async refund(ctx) {
    const h = ctx.order.payment.hubtel
    if (!h) return { kind: "failed", error: "Not paid through Hubtel" }
    if (Math.abs(ctx.amount - h.amountPaid) > 0.005) return { kind: "failed", error: "Hubtel refunds the full amount only" }
    return await requestHubtelRefund(h.orderId, ctx.refundId)
  },
  // Hubtel has no refund-status endpoint: the callback settles the refund, so a re-check just keeps it pending.
  async checkStatus(ctx, gatewayRef) {
    const ref = gatewayRef ?? ctx.order.payment.hubtel?.orderId
    if (!ref) return { kind: "unknown", error: "No Hubtel order id to track" }
    return { kind: "pending", ref }
  },
}
