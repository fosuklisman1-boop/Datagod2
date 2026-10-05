/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are untrusted JSON narrowed at use */
/**
 * Maps an admin refund API response to what the UI should do. Pure so the money-critical
 * branches (SETTLE_FAILED, wrong OTP, cancel) are unit tested.
 */
export type RefundAction = "execute" | "retry" | "reconcile" | "otp" | "cancel"

export interface SettleFailedDetail {
  ref: string | null
  refundId: string | null
  ledgerStatus: string | null
  note: string | null
  error: string | null
}

export type RefundOutcome =
  | { kind: "success"; message: string; refundId?: string }
  | { kind: "info"; message: string; refundId?: string }
  | { kind: "warning"; message: string; refundId?: string }
  | { kind: "awaiting_otp"; message: string; refundId?: string; wrongOtp: boolean }
  | { kind: "payout_failed"; message: string; refundId?: string }
  | { kind: "settle_failed"; message: string; detail: SettleFailedDetail }
  | { kind: "auth"; message: string }
  | { kind: "error"; message: string; code?: string }

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : v == null ? null : String(v))

export function interpretRefundResponse(action: RefundAction, httpStatus: number, body: unknown): RefundOutcome {
  const b: Record<string, any> = body && typeof body === "object" ? (body as Record<string, any>) : {}
  if (b.code === "SETTLE_FAILED") {
    const d = b.detail && typeof b.detail === "object" ? b.detail : {}
    return {
      kind: "settle_failed",
      message: str(b.error) ?? "The payout may have gone out but recording it failed.",
      detail: { ref: str(d.ref), refundId: str(d.refundId), ledgerStatus: str(d.ledgerStatus), note: str(d.note), error: str(d.error) },
    }
  }
  if (httpStatus === 403 || b.code === "ADMIN_REQUIRED") return { kind: "auth", message: "Sign in as an admin" }
  if (typeof b.status !== "string") {
    return { kind: "error", message: str(b.error) ?? str(b.message) ?? `Request failed (${httpStatus})`, code: str(b.code) ?? undefined }
  }
  const refundId = str(b.refundId) ?? undefined
  const message = str(b.message)
  if (b.status === "completed") return { kind: "success", message: message ?? "Refund completed", refundId }
  if (b.status === "awaiting_otp") {
    // Wrong OTP comes back as 200 + awaiting_otp + message; first-time OTP request has the "Enter the OTP" message.
    return { kind: "awaiting_otp", message: message ?? "Enter the OTP to release the payout", refundId, wrongOtp: action === "otp" }
  }
  if (b.status === "processing") return { kind: "warning", message: message ?? "Refund is processing, check its status in History", refundId }
  if (b.status === "failed") {
    if (action === "cancel") return { kind: "success", message: message ?? "Refund cancelled and the shop owner's cut restored", refundId }
    return { kind: "payout_failed", message: message ?? "Refund failed. The shop owner's cut was restored; you can retry from History.", refundId }
  }
  return { kind: "warning", message: message ?? `Refund ${b.status}`, refundId }
}

export const ATTENTION_STATUSES = ["reserved", "processing", "awaiting_otp"] as const
export const isAttentionStatus = (s: string): boolean => (ATTENTION_STATUSES as readonly string[]).includes(s)
