// Pure helpers for the Kuntanii provider. No I/O, no supabase, no fetch.

export type KuntaniiMode = "normal" | "instant"
export type KuntaniiPlan = { planCode: number; displayName: string; bundleSizeMb: number; unitPriceGhs: number }
export type KuntaniiOrderEntry = {
  orderReference?: string
  status?: string
  deliveryMode?: string
  totalAmountGhs?: number
  notReceivedStatus?: string | null
}
export type OurStatus = "processing" | "completed" | "failed"
export type KuntaniiErrorClass =
  | "NOT_ELIGIBLE"
  | "INSTANT_UNAVAILABLE"
  | "VALIDATION"
  | "ACCOUNT_HOLD"
  | "CONFLICT"
  | "RETRYABLE"
  | "NOT_FOUND"
  | "API_ERROR"

export const MAX_ATTEMPTS = 5

export function mapKuntaniiStatus(raw: string | undefined | null): OurStatus {
  const s = (raw ?? "").trim().toLowerCase()
  if (s === "processed" || s === "not received") return "completed"
  if (s === "cancelled") return "failed"
  return "processing"
}

export function aggregateOrdersStatus(orders: KuntaniiOrderEntry[]): OurStatus {
  if (!orders || orders.length === 0) return "processing"
  const statuses = orders.map((o) => mapKuntaniiStatus(o.status))
  if (statuses.includes("failed")) return "failed"
  if (statuses.every((s) => s === "completed")) return "completed"
  return "processing"
}

const ACCOUNT_HOLD_CODES = new Set([
  "INSUFFICIENT_CREDIT",
  "GOVERNING_ACCOUNT_CREDIT_HOLD",
  "PAYMENT_VERIFICATION_REQUIRED",
  "ACCOUNT_ORDERS_PAUSED",
  "PARENT_ORDERS_PAUSED",
  "ORDERS_PAUSED",
  "PRICING_PROFILE_REQUIRED",
  "FORBIDDEN",
  "UNAUTHORIZED",
])
const RETRYABLE_CODES = new Set([
  "RATE_LIMITED",
  "CREDIT_UNAVAILABLE",
  "BENEFICIARY_CHECK_UNAVAILABLE",
  "CREDIT_RELAY_UNAVAILABLE",
])

export function classifyKuntaniiError(
  httpStatus: number,
  code: string | undefined,
  mode: KuntaniiMode,
): KuntaniiErrorClass {
  if (code === "NO_APPROVED_RECIPIENTS" || code === "NO_ELIGIBLE_RECIPIENTS") return "NOT_ELIGIBLE"
  if (code === "VALIDATION_ERROR" || (!code && (httpStatus === 400 || httpStatus === 422))) {
    return mode === "instant" && httpStatus === 422 ? "INSTANT_UNAVAILABLE" : "VALIDATION"
  }
  if (code && ACCOUNT_HOLD_CODES.has(code)) return "ACCOUNT_HOLD"
  if (httpStatus === 401 || httpStatus === 402 || httpStatus === 403) return "ACCOUNT_HOLD"
  if (code === "CONFLICT" || httpStatus === 409) return "CONFLICT"
  if (code && RETRYABLE_CODES.has(code)) return "RETRYABLE"
  if (httpStatus === 429 || httpStatus >= 500) return "RETRYABLE"
  if (code === "NOT_FOUND" || httpStatus === 404) return "NOT_FOUND"
  return "API_ERROR"
}

export function isSizeSupported(plans: KuntaniiPlan[], sizeGb: number): boolean {
  if (!plans || plans.length === 0) return false
  if (!Number.isFinite(sizeGb) || sizeGb <= 0) return false
  const mb = sizeGb * 1024
  return plans.some((p) => p.bundleSizeMb === mb)
}

export function toLocalGhanaPhone(raw: string): string | null {
  const s = String(raw ?? "").replace(/[\s-]/g, "")
  let m = /^0(\d{9})$/.exec(s)
  if (m) return `0${m[1]}`
  m = /^\+?233(\d{9})$/.exec(s)
  if (m) return `0${m[1]}`
  return null
}

export function attemptId(orderId: string, n: number): string {
  return n <= 1 ? orderId : `${orderId}-r${n}`
}

// "next" only when every existing attempt was cancelled. Empty => "resume":
// never re-place blind when we cannot see what exists.
export function existingAttemptAction(orders: KuntaniiOrderEntry[]): "next" | "resume" {
  if (!orders || orders.length === 0) return "resume"
  return orders.every((o) => mapKuntaniiStatus(o.status) === "failed") ? "next" : "resume"
}

export function redactPhone(phone: string | null | undefined): string {
  if (!phone) return ""
  const s = String(phone)
  const tail = s.slice(-3)
  return "*".repeat(Math.max(0, s.length - 3)) + tail
}

export function sumCost(orders: KuntaniiOrderEntry[] | undefined, fallbackTotal?: number): number | undefined {
  const amounts = (orders ?? [])
    .map((o) => o.totalAmountGhs)
    .filter((a): a is number => typeof a === "number" && Number.isFinite(a))
  if (amounts.length > 0) {
    return Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100
  }
  if (typeof fallbackTotal === "number" && Number.isFinite(fallbackTotal)) return fallbackTotal
  return undefined
}
