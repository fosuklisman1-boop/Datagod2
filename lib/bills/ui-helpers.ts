export const UNCONFIRMED_PAYMENT_MESSAGE =
  "We could not confirm your payment. Please check your wallet and recent payments before trying again."

export type PayOutcome =
  | { kind: "done"; reference: string; status: string }
  | { kind: "retry"; message: string }
  | { kind: "back"; message: string }

/** Statuses the pay route returns deliberately, with a customer-safe message in `error`. */
const KNOWN_FAILURES = new Set([400, 402, 403, 409, 422])

/**
 * Classifies a /api/bills/pay response. Anything that is not a deliberate, known answer (timeouts, crashes,
 * non-JSON 5xx bodies, network errors) is "could not confirm" - never "Payment failed" - because the debit may
 * have happened. The verify token is single-use, so every "back" outcome drops it.
 */
export function classifyPayResponse(status: number, json: any): PayOutcome {
  if (status === 200 && json?.success) {
    return { kind: "done", reference: String(json.order?.reference_code ?? ""), status: String(json.order?.status ?? "processing") }
  }
  const apiMsg = typeof json?.error === "string" ? json.error : ""
  // 503/429 fail before an order is inserted, so the token is still good.
  if (status === 503 || status === 429) return { kind: "retry", message: apiMsg || "Temporarily unavailable. Please try again shortly." }
  if (status === 402) return { kind: "back", message: apiMsg || "Insufficient wallet balance. Top up your wallet and try again." }
  if (KNOWN_FAILURES.has(status)) return { kind: "back", message: apiMsg || "Payment failed. Please verify the account and try again." }
  return { kind: "back", message: UNCONFIRMED_PAYMENT_MESSAGE }
}

/** Customer-facing label for a bill order in the recent payments list. */
export function billStatusLabel(status: string, paymentStatus: string): { label: string; tone: string } {
  if (paymentStatus === "unpaid") {
    if (status === "pending") return { label: "Not charged", tone: "muted" }
    if (status === "failed") return { label: "Failed — not charged", tone: "failed" }
  }
  return { label: status, tone: status }
}
