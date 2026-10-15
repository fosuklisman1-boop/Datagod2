import { isCommissionTable, type RefundContext, type RefundGateway, type GatewayOutcome } from "../types"

// Manual refund: the admin sends the money themselves (MoMo app, bank, cash) BEFORE confirming, so this gateway
// moves no money — it only completes the ledger (clawback, order -> refunded, customer SMS) with the admin's
// optional reference. Commission orders keep their own "Mark refunded manually" button.
const settled = (ref: string): GatewayOutcome => ({ kind: "completed", ref })

export const manualGateway: RefundGateway = {
  id: "manual",
  label: "Manual refund (I send the money myself)",
  supports(order) {
    if (isCommissionTable(order.table)) return { ok: false, reason: "Use \"Mark refunded manually\" for this order" }
    return { ok: true }
  },
  async refund(ctx: RefundContext) {
    return settled(`manual: ${ctx.manualReference?.trim() || "no reference"}`.slice(0, 200))
  },
  // A manual refund stuck in processing (ledger settle failed after the admin confirmed): the money already left
  // by hand, so a re-check completes it with the stored reference. Commission rows also use gateway 'manual'
  // (their "Mark refunded manually" path) and must finish through that path, which keeps the note + refund method.
  async checkStatus(ctx, gatewayRef) {
    if (isCommissionTable(ctx.order.table)) return { kind: "unknown", error: "Finish this with \"Mark refunded manually\" on the order" }
    return settled(gatewayRef || "manual: no reference")
  },
}
