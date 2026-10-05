import type { DispatchOutcome } from "./types"

export interface EligibilityInput {
  orderStatus: string
  paymentStatus: string
  hasActiveRefund: boolean
  dispatchOutcome: DispatchOutcome | null
  trackingStatuses: string[]
  externalOrderId: string | null
}

export type EligibilityCode =
  | "NOT_PENDING" | "ALREADY_REFUNDED" | "DISPATCH_IN_PROGRESS" | "DISPATCH_UNKNOWN"
  | "PROVIDER_IN_PROGRESS" | "SENT_TO_PROVIDER"

export type Eligibility = { eligible: true } | { eligible: false; code: EligibilityCode; reason: string }

const TERMINAL_FAILED = new Set(["failed", "error", "abandoned"])
const IN_FLIGHT = new Set(["pending", "processing", "retrying"])

const no = (code: EligibilityCode, reason: string): Eligibility => ({ eligible: false, code, reason })

export function evaluateEligibility(i: EligibilityInput): Eligibility {
  if (i.orderStatus !== "pending" || i.paymentStatus !== "completed") return no("NOT_PENDING", "Order is not a paid, pending order")
  if (i.hasActiveRefund) return no("ALREADY_REFUNDED", "A refund already exists for this order")
  if (i.dispatchOutcome === "claimed") return no("DISPATCH_IN_PROGRESS", "Being sent to a provider right now")
  if (i.dispatchOutcome === "unknown") return no("DISPATCH_UNKNOWN", "A provider call ended with an unknown result — investigate before refunding")

  const live = i.trackingStatuses.filter((s) => !TERMINAL_FAILED.has(s))
  if (live.some((s) => IN_FLIGHT.has(s))) return no("PROVIDER_IN_PROGRESS", "Provider order is still in progress")
  if (live.length > 0) return no("SENT_TO_PROVIDER", "Provider reports the order was delivered/accepted")

  const hasTracking = i.trackingStatuses.length > 0
  if (!hasTracking && (i.dispatchOutcome === "submitted" || i.externalOrderId)) {
    return no("SENT_TO_PROVIDER", "Sent to a provider and failure cannot be confirmed")
  }
  return { eligible: true }
}
