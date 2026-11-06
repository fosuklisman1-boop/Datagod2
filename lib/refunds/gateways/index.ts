import { normalizeGhanaPhone } from "@/lib/phone-format"
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
// Paystack's reversal first, so a Paystack-paid order pre-selects it and doesn't spend the Hubtel balance by default.
// It's refused on any other order, which then pre-selects Hubtel Send Money.
const GATEWAYS: RefundGateway[] = [paystackGateway, hubtelSendGateway, paystackPayoutGateway, moolreGateway, hubtelGateway, walletGateway, manualGateway]

export const listGateways = (): RefundGateway[] => GATEWAYS
export const getGateway = (id: string): RefundGateway | undefined => GATEWAYS.find((g) => g.id === id)

/**
 * Gateways a Hubtel-paid order (a Hubtel collection whose attempt is paid) may be refunded through (owner decision
 * 2026-11-05): Hubtel Send Money, the two MoMo payouts (backups for an empty Hubtel disbursement balance), the wallet
 * where it already applies, and manual. Paystack never saw this payment, so its reversal is refused, as is the Hubtel
 * Online Checkout refund API (a different payment rail).
 */
export const HUBTEL_PAID_GATEWAYS: readonly string[] = ["hubtel_send", "paystack_payout", "moolre", "wallet", "manual"]

const MOMO_PAYOUTS: readonly string[] = ["moolre", "paystack_payout"]

export const HUBTEL_PAID_REASON ="Paystack never held this Hubtel payment — refund it with a payout, the wallet or manually"

/** gateway.supports() behind the Hubtel-paid allowlist. Every caller that offers or executes a gateway goes through this. */
export function supportOf(gateway: RefundGateway, order: RefundableOrder): GatewaySupport {
  if (order.payment.hubtelCollection && !HUBTEL_PAID_GATEWAYS.includes(gateway.id)) return { ok: false, reason: HUBTEL_PAID_REASON }
  // Two paid attempts: a person decides, by hand or through Hubtel Send Money (owner decision 2026-11-06: a free amount).
  if (order.payment.hubtelCollection && (order.payment.hubtelAttempt?.paidAttempts ?? 0) > 1 && gateway.id !== "manual" && gateway.id !== "hubtel_send") {
    return { ok: false, reason: "This order has more than one paid Hubtel payment — refund manually" }
  }
  // A MoMo payout returns the money only to the number that paid. A number on the order row may be one a buyer typed.
  if (order.payment.hubtelCollection && MOMO_PAYOUTS.includes(gateway.id)) {
    const paidFrom = order.payment.hubtelAttempt?.msisdn
    if (!paidFrom) return { ok: false, reason: "Hubtel did not record the paying number — refund to the wallet or manually" }
    const destination = order.payment.payerPhone
    if (!destination || normalizeGhanaPhone(destination) !== normalizeGhanaPhone(paidFrom)) {
      return { ok: false, reason: "Payouts on a Hubtel payment only go to the number that paid — refund to the wallet or manually" }
    }
  }
  return gateway.supports(order)
}
