import { refundTransaction } from "@/lib/paystack"
import type { RefundGateway } from "../types"

export const paystackGateway: RefundGateway = {
  id: "paystack",
  label: "Paystack (reverse original charge)",
  supports(order) {
    if (order.payment.gateway === "paystack" && order.payment.reference) return { ok: true }
    return { ok: false, reason: "Order was not paid through Paystack" }
  },
  async refund(ctx) {
    try {
      const data = await refundTransaction(ctx.order.payment.reference!, ctx.amount)
      return { kind: "completed", ref: String(data?.id ?? ctx.order.payment.reference) }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Paystack refund failed"
      // "failed" must mean money definitely did not move. Only a 4xx rejection that Paystack answered
      // guarantees that; a network error, timeout, non-JSON body or 5xx may still have created the refund.
      const httpStatus = (err as { httpStatus?: number } | null)?.httpStatus
      if (typeof httpStatus === "number" && httpStatus >= 400 && httpStatus < 500) return { kind: "failed", error: message }
      return { kind: "unknown", error: message }
    }
  },
}
