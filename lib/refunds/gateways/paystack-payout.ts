import {
  createRecipient, initiateTransfer, finalizeTransfer, getTransferStatus,
  mapNetworkToPaystackBankCode, type PaystackTransferResult,
} from "@/lib/paystack-transfer"
import { momoNetworkForMoolre } from "./moolre"
import type { GatewayOutcome, RefundGateway } from "../types"

function toOutcome(r: PaystackTransferResult | null, fallbackRef: string): GatewayOutcome {
  if (!r) return { kind: "unknown", error: "Paystack did not answer — check status before retrying" }
  const ref = r.transferCode || fallbackRef
  switch (r.status) {
    case "success": return { kind: "completed", ref }
    case "pending": return { kind: "pending", ref }
    case "otp": return { kind: "otp", ref }
    default: return { kind: "failed", error: r.errorMessage || "Paystack rejected the transfer" }
  }
}

export const paystackPayoutGateway: RefundGateway = {
  id: "paystack_payout",
  label: "Paystack (MoMo payout, needs OTP)",
  supports(order) {
    const phone = order.payment.payerPhone
    if (!phone) return { ok: false, reason: "No payer number on the order" }
    const network = momoNetworkForMoolre(phone)
    if (!network || !mapNetworkToPaystackBankCode(network)) return { ok: false, reason: "Payer number is not a recognised MoMo network" }
    return { ok: true }
  },
  async refund(ctx) {
    const phone = ctx.destinationPhone
    const network = phone ? momoNetworkForMoolre(phone) : null
    const bankCode = network ? mapNetworkToPaystackBankCode(network) : undefined
    if (!phone || !bankCode) return { kind: "failed", error: "No valid MoMo number to pay out to" }

    const recipient = await createRecipient({ name: "Datagod customer refund", accountNumber: phone, bankCode, type: "mobile_money" })
    if (!recipient.recipientCode) return { kind: "failed", error: recipient.error ?? "Could not create Paystack recipient" }

    // reference = refund id: Paystack rejects a duplicate reference, so a double click cannot pay twice.
    const result = await initiateTransfer({
      recipientCode: recipient.recipientCode, amount: ctx.amount, reference: ctx.refundId,
      reason: `Datagod refund ${ctx.refundId.slice(0, 8)}`,
    })
    return toOutcome(result, ctx.refundId)
  },
  async finalizeOtp(_ctx, gatewayRef, otp) {
    const result = await finalizeTransfer(gatewayRef, otp)
    // finalizeTransfer reports every non-2xx (including a mistyped OTP) as "failed". A bad code does
    // NOT cancel the transfer — it stays awaiting OTP — so never treat it as a definitive failure.
    if (result && result.status === "failed") return { kind: "otp", ref: gatewayRef }
    return toOutcome(result, gatewayRef)
  },
  async checkStatus(ctx, gatewayRef) {
    return toOutcome(await getTransferStatus(ctx.refundId), gatewayRef ?? ctx.refundId)
  },
}
