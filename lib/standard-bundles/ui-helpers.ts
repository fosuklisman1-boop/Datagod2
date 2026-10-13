import { classifyPayResponse, UNCONFIRMED_PAYMENT_MESSAGE } from "@/lib/bills/ui-helpers"
import { normalizeGhanaPhone, validateNetworkPrefix } from "@/lib/phone-format"

export const BUNDLE_CHANGED_MESSAGE = "This bundle changed - please refresh and pick it again."
export const BUNDLE_UNCONFIRMED_MESSAGE = UNCONFIRMED_PAYMENT_MESSAGE

export type BuyOutcome =
  | { kind: "done"; reference: string; status: string }
  | { kind: "refresh"; message: string }
  | { kind: "insufficient"; message: string }
  | { kind: "retry"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "unconfirmed"; message: string }

/** Client-side recipient check for the chosen network. Returns an error message, or null when OK. */
export function validateBundleRecipient(network: string, phone: string): string | null {
  const trimmed = phone.trim()
  if (!trimmed) return "Enter the recipient's phone number."
  if (!normalizeGhanaPhone(trimmed)) return "Please enter a valid Ghana mobile number."
  const check = validateNetworkPrefix(network, trimmed)
  return check.ok ? null : check.message
}

/**
 * Classifies a /api/standard-bundles/buy response. Anything that is not a deliberate, known answer
 * (timeouts, crashes, non-JSON 5xx, network errors) is "unconfirmed", never "failed": the wallet may
 * already have been debited.
 */
export function classifyBuyResponse(status: number, json: any): BuyOutcome {
  if (status === 409) return { kind: "refresh", message: BUNDLE_CHANGED_MESSAGE }
  if (status === 402) {
    return { kind: "insufficient", message: (typeof json?.error === "string" && json.error) || "Insufficient wallet balance." }
  }
  // A deliberate service answer that carries an order the server has marked failed.
  if (status !== 200 && status !== 0 && json?.order?.status === "failed" && typeof json?.error === "string" && json.error) {
    return { kind: "failed", message: json.error }
  }
  const o = classifyPayResponse(status, json)
  if (o.kind === "done") {
    if (o.status === "failed") return { kind: "failed", message: "Purchase failed. If you were charged, a refund will follow." }
    return o
  }
  if (o.kind === "retry") return o
  return o.message === UNCONFIRMED_PAYMENT_MESSAGE
    ? { kind: "unconfirmed", message: BUNDLE_UNCONFIRMED_MESSAGE }
    : { kind: "failed", message: o.message }
}

/**
 * True only after a DEFINITE non-delivery. Uncertain outcomes (timeout/network error = status 0 or null,
 * 5xx, unparseable 2xx, pending/processing orders) keep the key so a retry dedupes server-side.
 * 429/503 are rejected before any order exists, so reusing the key is harmless and we keep it.
 */
export function shouldRotateIdempotencyKey(httpStatus: number | null, json: any): boolean {
  if (httpStatus === null || httpStatus === 0) return false
  if (json?.order?.status === "failed") return true
  if (httpStatus === 429) return false
  return httpStatus >= 400 && httpStatus < 500
}

export function bundleStatusLabel(status: string, paymentStatus: string): { label: string; tone: string } {
  if (paymentStatus === "unpaid") {
    if (status === "pending") return { label: "Not charged", tone: "muted" }
    if (status === "failed") return { label: "Failed - not charged", tone: "failed" }
  }
  if (status === "pending" || status === "processing") return { label: "Processing", tone: "processing" }
  return { label: status.charAt(0).toUpperCase() + status.slice(1), tone: status }
}
