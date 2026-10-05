import { initiateTransfer, getTransferStatus } from "@/lib/moolre-transfer"
import { detectGhanaNetwork } from "@/lib/phone-format"
import { isWalletOnlyTable, WALLET_ONLY_REASON, type GatewayOutcome, type RefundGateway } from "../types"

export function momoNetworkForMoolre(phone: string): "MTN" | "TELECEL" | "AT" | null {
  const n = detectGhanaNetwork(phone)
  return n === "UNKNOWN" ? null : n
}

function fromTxStatus(txstatus: number, ref: string, error?: string): GatewayOutcome {
  if (txstatus === 1) return { kind: "completed", ref }
  if (txstatus === 0) return { kind: "pending", ref }
  if (txstatus === 2) return { kind: "failed", error: error || "Moolre rejected the transfer" }
  return { kind: "unknown", error: "Moolre returned an unknown transfer status" }
}

export const moolreGateway: RefundGateway = {
  id: "moolre",
  label: "Moolre (MoMo payout to payer)",
  supports(order) {
    if (isWalletOnlyTable(order.table)) return { ok: false, reason: WALLET_ONLY_REASON }
    const phone = order.payment.payerPhone
    if (!phone) return { ok: false, reason: "No payer number on the order" }
    if (!momoNetworkForMoolre(phone)) return { ok: false, reason: "Payer number is not a recognised MoMo network" }
    return { ok: true }
  },
  async refund(ctx) {
    const phone = ctx.destinationPhone
    const network = phone ? momoNetworkForMoolre(phone) : null
    if (!phone || !network) return { kind: "failed", error: "No valid MoMo number to pay out to" }
    const result = await initiateTransfer({
      phone, network, amount: ctx.amount, externalref: ctx.refundId,
      reference: `Datagod refund ${ctx.refundId.slice(0, 8)}`,
    })
    if (!result) return { kind: "unknown", error: "Moolre did not answer — check status before retrying" }
    // "failed" must mean money definitely did not move: only an insufficient-balance rejection or a
    // parsed (JSON), non-5xx rejection. A txstatus 2 synthesized from a non-JSON body or a 5xx is ambiguous.
    if (result.txstatus === 2) {
      const definitive = result.insufficientBalance === true || (result.parsed === true && (result.httpStatus ?? 0) < 500)
      if (!definitive) return { kind: "unknown", error: result.errorMessage || "Moolre response was ambiguous — check status before retrying" }
    }
    return fromTxStatus(result.txstatus, result.transactionId || ctx.refundId, result.errorMessage)
  },
  async checkStatus(ctx) {
    const result = await getTransferStatus(ctx.refundId)
    if (!result) return { kind: "unknown", error: "Could not reach Moolre to check status" }
    return fromTxStatus(result.txstatus, result.transactionId || ctx.refundId)
  },
}
