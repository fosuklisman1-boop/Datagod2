import { requestHubtelRefund } from "../hubtel-refund"
import { isWalletOnlyTable, WALLET_ONLY_REASON, type RefundGateway } from "../types"

// Hubtel allows refunds for 45 days from payment; stop at 44 so a clock skew or a slow admin never hits the edge.
const MAX_AGE_MS = 44 * 86_400_000
// Hubtel rejects refunds under GHS 1.00 (code 4000).
const MIN_AMOUNT = 1
const round2 = (n: number) => Math.round(n * 100) / 100
const money = (n: number | null) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "unknown")

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
    // amountPaid is the gross (order price + Hubtel's customer fee). What we refund and ledger is the order price, so
    // only proceed when Hubtel's net figure is exactly that price; anything else (or unknown) is a manual refund.
    const net = h.amountAfterCharges
    if (typeof net !== "number" || !Number.isFinite(net) || net < MIN_AMOUNT || !(Math.abs(net - order.paid) < 0.005)) {
      return { ok: false, reason: `Hubtel net amount GHS ${money(net)} does not match the order price GHS ${money(order.paid)} — refund manually` }
    }
    const paidAt = Date.parse(h.paidAt)
    if (!Number.isFinite(paidAt) || Date.now() - paidAt > MAX_AGE_MS) return { ok: false, reason: "Hubtel refunds are only possible within 45 days of payment" }
    return { ok: true }
  },
  // The order price (= Hubtel's net amount, checked in supports), never the gross the customer paid Hubtel.
  fixedAmount(order) {
    return order.payment.hubtel ? round2(order.paid) : null
  },
  async refund(ctx) {
    const h = ctx.order.payment.hubtel
    if (!h) return { kind: "failed", error: "Not paid through Hubtel" }
    const net = h.amountAfterCharges
    if (typeof net !== "number" || !Number.isFinite(net)) return { kind: "failed", error: "Hubtel net amount unknown — refund manually" }
    if (Math.abs(ctx.amount - net) > 0.005) return { kind: "failed", error: "Hubtel refunds the full amount only" }
    return await requestHubtelRefund(h.orderId, ctx.refundId)
  },
  // Hubtel has no refund-status endpoint: the callback settles the refund. `unknown` passes a null ref, so
  // mark_refund_processing's COALESCE keeps the stored Hubtel orderId the callback is matched against.
  async checkStatus() {
    return { kind: "unknown", error: "Hubtel has no refund-status lookup — waiting for Hubtel's callback; confirm with Hubtel before resolving" }
  },
}
