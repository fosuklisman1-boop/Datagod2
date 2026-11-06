import { checkSendStatus, hubtelChannelFor, isHubtelChannel, sendMoney, toHubtelMsisdn } from "../hubtel-send-client"
import { isWalletOnlyTable, WALLET_ONLY_REASON, type GatewayOutcome, type RefundableOrder, type RefundGateway } from "../types"

/** Nothing can be sent until this is exactly "true"; checking the status of a send already made never needs it. */
const enabled = () => process.env.HUBTEL_SEND_REFUNDS_ENABLED === "true"

const round2 = (n: number) => Math.round(n * 100) / 100

/** The destination as 233XXXXXXXXX plus the Hubtel channel to send on, or null when either cannot be settled. */
function destinationOf(order: RefundableOrder, phone: string | null): { msisdn: string; channel: string } | null {
  if (!phone) return null
  const msisdn = toHubtelMsisdn(phone)
  if (!msisdn) return null
  const a = order.payment.hubtelAttempt
  // The channel the payer paid on survives number portability; it only applies to the very number that paid.
  const sameNumber = !!a?.msisdn && toHubtelMsisdn(a.msisdn) === msisdn
  const channel = sameNumber && isHubtelChannel(a?.channel) ? a!.channel! : hubtelChannelFor(phone)
  return channel ? { msisdn, channel } : null
}

/**
 * Why this order cannot be paid out through Hubtel Send Money, or null when it can. Never includes a phone number.
 * Owner decision 2026-11-06: it works like the Paystack payout, a free amount to the order's payer number. The amount
 * is limited only by what the order paid (validateRefundAmount and the reserve RPC). It stays Hubtel-paid orders only,
 * and a collection attempt must be confirmed paid: money that may not have landed can't be refunded.
 */
function refusal(order: RefundableOrder, phone: string | null): string | null {
  if (isWalletOnlyTable(order.table)) return WALLET_ONLY_REASON
  if (order.payment.hubtelCollection) {
    if (order.payment.hubtelAttempt?.status !== "paid") return "The Hubtel payment is not confirmed as paid yet"
  } else if (!order.payment.hubtel) {
    return "Not paid through Hubtel"
  }
  if (!phone) return "No payer number on the order"
  if (!destinationOf(order, phone)) return "Payer number is not a recognised MoMo network"
  return null
}

export const hubtelSendGateway: RefundGateway = {
  id: "hubtel_send",
  label: "Hubtel (MoMo payout to payer)",
  supports(order) {
    if (!enabled()) return { ok: false, reason: "Hubtel payouts are not enabled" }
    const why = refusal(order, order.payment.payerPhone)
    return why ? { ok: false, reason: why } : { ok: true }
  },
  async refund(ctx): Promise<GatewayOutcome> {
    // Everything is re-checked here: a failure before the send means nothing was sent, so it is a clean `failed`.
    if (!enabled()) return { kind: "failed", error: "Hubtel payouts are not enabled — nothing was sent" }
    const phone = ctx.destinationPhone
    const why = refusal(ctx.order, phone)
    if (why) return { kind: "failed", error: `${why} — nothing was sent` }
    const dest = destinationOf(ctx.order, phone)
    const amount = ctx.amount
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || round2(amount) !== amount) {
      return { kind: "failed", error: "Invalid refund amount — nothing was sent" }
    }
    if (!dest) return { kind: "failed", error: "No valid MoMo number to pay out to — nothing was sent" }
    return sendMoney({ refundId: ctx.refundId, msisdn: dest.msisdn, channel: dest.channel, amount })
  },
  // Looked up by the refund id (its ClientReference). Deliberately not behind the switch: a send already made must
  // still be reconcilable after the switch is turned off.
  async checkStatus(ctx, gatewayRef) {
    const outcome = await checkSendStatus({ refundId: ctx.refundId, amount: ctx.amount })
    // A no-match must not overwrite Hubtel's transaction id: it's the proof that Hubtel accepted the send.
    return outcome.kind === "pending" && gatewayRef ? { kind: "pending", ref: gatewayRef } : outcome
  },
}
