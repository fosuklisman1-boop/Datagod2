import type { GatewaySupport, RefundableOrder, RefundGateway } from "../types"
import { paystackGateway } from "./paystack"
import { paystackPayoutGateway } from "./paystack-payout"
import { moolreGateway } from "./moolre"
import { hubtelGateway } from "./hubtel"
import { hubtelSendGateway } from "./hubtel-send"
import { walletGateway } from "./wallet"
import { manualGateway } from "./manual"

// To add a gateway: implement RefundGateway in its own file and append it here.
// hubtel_send is FIRST: the refund dialog pre-selects the first supported gateway, and for a Hubtel-paid order that
// should be paying the customer back from the Hubtel account. It supports nothing else, so Paystack-paid orders still
// pre-select Paystack. Manual stays LAST: the first supported gateway must be a real payout.
const GATEWAYS: RefundGateway[] = [hubtelSendGateway, paystackGateway, paystackPayoutGateway, moolreGateway, hubtelGateway, walletGateway, manualGateway]

export const listGateways = (): RefundGateway[] => GATEWAYS
export const getGateway = (id: string): RefundGateway | undefined => GATEWAYS.find((g) => g.id === id)

/**
 * Gateways a Hubtel-paid order (a Hubtel collection whose attempt is paid) may be refunded through (owner decision
 * 2026-11-05): Hubtel Send Money, the two MoMo payouts (backups for an empty Hubtel disbursement balance), the wallet
 * where it already applies, and manual. Paystack never saw this payment, so its reversal is refused, as is the Hubtel
 * Online Checkout refund API (a different payment rail).
 */
export const HUBTEL_PAID_GATEWAYS: readonly string[] = ["hubtel_send", "paystack_payout", "moolre", "wallet", "manual"]

export const HUBTEL_PAID_REASON = "Paystack never held this Hubtel payment — refund it with a payout, the wallet or manually"

/** gateway.supports() behind the Hubtel-paid allowlist. Every caller that offers or executes a gateway goes through this. */
export function supportOf(gateway: RefundGateway, order: RefundableOrder): GatewaySupport {
  if (order.payment.hubtelCollection && !HUBTEL_PAID_GATEWAYS.includes(gateway.id)) return { ok: false, reason: HUBTEL_PAID_REASON }
  // Two paid attempts: which payment to return, and how much, needs a person.
  if (order.payment.hubtelCollection && (order.payment.hubtelAttempt?.paidAttempts ?? 0) > 1 && gateway.id !== "manual") {
    return { ok: false, reason: "This order has more than one paid Hubtel payment — refund manually" }
  }
  return gateway.supports(order)
}
