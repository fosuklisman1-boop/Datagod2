import { fetchRefund, refundTransaction } from "@/lib/paystack"
import type { GatewayOutcome, RefundGateway } from "../types"

/**
 * Maps a Paystack refund `status` to a gateway outcome. OPEN VERIFICATION: the vocabulary below comes from
 * Paystack's docs, not a live test (pending -> processing -> processed | failed, plus needs-attention).
 *  - processed                            => completed (money moved)
 *  - pending / processing / needs-attention => pending (accepted, not done; needs-attention requires an admin to act
 *    at Paystack, so we must neither compensate nor call it done)
 *  - failed                               => failed (Paystack could not process it; the amount returns to our balance)
 *  - anything else                        => unknown (never completed, never failed)
 */
export function mapPaystackRefundStatus(status: unknown, ref: string): GatewayOutcome {
  const s = typeof status === "string" ? status.trim().toLowerCase().replace(/_/g, "-") : ""
  if (s === "processed") return { kind: "completed", ref }
  if (s === "pending" || s === "processing" || s === "needs-attention") return { kind: "pending", ref }
  if (s === "failed") return { kind: "failed", error: "Paystack could not process the refund" }
  const shown = typeof status === "string" && status.trim() ? `"${status.trim().slice(0, 40)}"` : "missing"
  return { kind: "unknown", error: `Paystack returned an unrecognised refund status (${shown}); verify at the Paystack dashboard` }
}

/** Paystack refund ids are numeric. Anything else (e.g. a transaction reference stored by older code) cannot be looked up. */
const REFUND_ID_RE = /^\d{1,20}$/
export const isLookupableRefundId = (v: unknown): v is string => typeof v === "string" && REFUND_ID_RE.test(v.trim())

const httpStatusOf = (err: unknown): number | undefined => (err as { httpStatus?: number } | null)?.httpStatus

/**
 * Read-only lookup of one refund at Paystack. NEVER returns `failed` from an HTTP/network error: only an explicit
 * data.status === "failed" does. rawStatus is the string Paystack returned (null when unavailable).
 */
export async function describePaystackRefund(gatewayRef: string | null | undefined): Promise<{ outcome: GatewayOutcome; rawStatus: string | null }> {
  if (!isLookupableRefundId(gatewayRef)) {
    return { outcome: { kind: "unknown", error: "No Paystack refund id is stored for this refund, so it cannot be looked up; check the Paystack dashboard" }, rawStatus: null }
  }
  const id = gatewayRef.trim()
  try {
    const data = await fetchRefund(id)
    const raw = typeof data?.status === "string" ? data.status : null
    return { outcome: mapPaystackRefundStatus(data?.status, id), rawStatus: raw }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Paystack refund lookup failed"
    const notFound = httpStatusOf(err) === 404
    return { outcome: { kind: "unknown", error: notFound ? `Paystack has no refund ${id} (not found); verify at the Paystack dashboard` : message }, rawStatus: null }
  }
}

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
      const rawId = data?.id
      const id = typeof rawId === "number" || typeof rawId === "string" ? String(rawId).trim() : ""
      if (!id) {
        // The refund may exist but we could never re-check it: never compensate, never call it done.
        return { kind: "unknown", error: "Paystack accepted the refund but returned no refund id; verify at the Paystack dashboard" }
      }
      return mapPaystackRefundStatus(data?.status, id)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Paystack refund failed"
      // "failed" must mean money definitely did not move. Only a 4xx rejection that Paystack answered
      // guarantees that; a network error, timeout, non-JSON body or 5xx may still have created the refund.
      const httpStatus = httpStatusOf(err)
      if (typeof httpStatus === "number" && httpStatus >= 400 && httpStatus < 500) return { kind: "failed", error: message }
      return { kind: "unknown", error: message }
    }
  },
  async checkStatus(_ctx, gatewayRef) {
    return (await describePaystackRefund(gatewayRef)).outcome
  },
}
