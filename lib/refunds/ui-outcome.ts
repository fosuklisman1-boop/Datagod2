/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are untrusted JSON narrowed at use */
/**
 * Maps an admin refund API response to what the UI should do. Pure so the money-critical
 * branches (SETTLE_FAILED, wrong OTP, cancel) are unit tested.
 */
import { isInFlight } from "./staleness"

export type RefundAction = "execute" | "retry" | "reconcile" | "otp" | "cancel"

export interface SettleFailedDetail {
  ref: string | null
  refundId: string | null
  ledgerStatus: string | null
  note: string | null
  error: string | null
  outcome: string | null
  conflict: string | null
}

export type RefundOutcome =
  | { kind: "success"; message: string; refundId?: string }
  | { kind: "info"; message: string; refundId?: string }
  | { kind: "warning"; message: string; refundId?: string }
  | { kind: "awaiting_otp"; message: string; refundId?: string; wrongOtp: boolean }
  | { kind: "payout_failed"; message: string; refundId?: string }
  | { kind: "settle_failed"; message: string; detail: SettleFailedDetail }
  | { kind: "auth"; message: string }
  | { kind: "error"; message: string; code?: string; status?: number }

const str = (v: unknown): string | null => {
  if (typeof v === "string") return v ? v : null
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return null
}

export function interpretRefundResponse(action: RefundAction, httpStatus: number, body: unknown): RefundOutcome {
  const b: Record<string, any> = body && typeof body === "object" ? (body as Record<string, any>) : {}
  if (b.code === "SETTLE_FAILED") {
    const d = b.detail && typeof b.detail === "object" ? b.detail : {}
    return {
      kind: "settle_failed",
      message: str(b.error) ?? "The payout may have gone out but recording it failed.",
      detail: { ref: str(d.ref), refundId: str(d.refundId), ledgerStatus: str(d.ledgerStatus), note: str(d.note), error: str(d.error), outcome: str(d.outcome), conflict: str(d.conflict) },
    }
  }
  if (httpStatus === 403 || b.code === "ADMIN_REQUIRED") return { kind: "auth", message: "Sign in as an admin" }
  if (typeof b.status !== "string") {
    return { kind: "error", message: str(b.error) ?? str(b.message) ?? `Request failed (${httpStatus})`, code: str(b.code) ?? undefined, status: httpStatus }
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

const ATTENTION_TEXT: Record<string, string> = {
  reserved: "Stuck after a crash. The payout may have gone out. Check status before doing anything else.",
  processing: "Awaiting gateway confirmation. Check status.",
  awaiting_otp: "Waiting for the payout OTP. Enter it, check status, or cancel.",
}

/** Hint for a refund needing attention; reserved/processing rows under 5 minutes old may still have the payout call running. */
export function attentionHint(r: { status: string; updated_at?: string | null }, now: number): { inFlight: boolean; text: string } {
  if (isInFlight(r, now)) return { inFlight: true, text: "In flight — retry in a few minutes" }
  return { inFlight: false, text: ATTENTION_TEXT[r.status] ?? "" }
}

export type ErrorTreatment = "ambiguous" | "stale" | "rejected"

const STALE_CODES = ["ORDER_NOT_PENDING", "ALREADY_REFUNDED", "DISPATCH_ACTIVE", "NOT_ELIGIBLE", "IN_FLIGHT"]

/**
 * How the refund dialog must treat a non-success execute outcome.
 * ambiguous: we cannot tell whether money moved (network error, non-JSON, 5xx, codeless) - disarm, close, reload.
 * stale: the order changed under us (409-style) - reload lists, disarm.
 * rejected: a definite pre-reserve rejection (SHORTFALL, BAD_AMOUNT, 403 ...) - keep dialog open, disarm.
 */
export function treatAsAmbiguous(outcome: RefundOutcome): ErrorTreatment {
  if (outcome.kind === "settle_failed") return "ambiguous"
  if (outcome.kind === "auth") return "rejected"
  if (outcome.kind !== "error") return "rejected"
  const status = outcome.status ?? 0
  if (!outcome.code || status === 0 || status >= 500) return "ambiguous"
  if (status === 409 || STALE_CODES.includes(outcome.code)) return "stale"
  return "rejected"
}

/** Strict money input: digits with at most 2 decimals. Returns the exact number to send, or null. */
export function parseRefundAmount(input: string): number | null {
  const t = input.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  const n = Number(t)
  return n > 0 ? n : null
}

/** A refund the admin cancelled (stored as failed with a "Cancelled by admin" error). */
export const isCancelledRefund = (r: { status: string; error: string | null }): boolean =>
  r.status === "failed" && (r.error ?? "").startsWith("Cancelled by admin")

export type VerificationSeverity = "ok" | "info" | "warning" | "destructive"

export const LEDGER_MISMATCH_TEXT = "Ledger says completed but Paystack says failed — the customer was NOT paid. See runbook."

/** Pure: turns a gateway-status response into the text + severity the history row shows. */
export function describeVerification(r: { ledgerStatus: string; gatewayStatus: string | null; rawStatus?: string | null; message?: string | null }): { severity: VerificationSeverity; text: string } {
  const raw = r.rawStatus ? r.rawStatus : r.gatewayStatus ?? "unknown"
  const says = `Paystack says: ${raw}`
  if (r.gatewayStatus === "failed") {
    if (r.ledgerStatus === "completed") return { severity: "destructive", text: LEDGER_MISMATCH_TEXT }
    if (r.ledgerStatus === "processing") return { severity: "warning", text: `${says}. Use "Check status" to restore the owner's cut.` }
    return { severity: "info", text: says }
  }
  if (r.gatewayStatus === "completed") {
    if (r.ledgerStatus === "processing") return { severity: "warning", text: `${says}. Use "Check status" to settle the ledger.` }
    return { severity: "ok", text: says }
  }
  if (r.gatewayStatus === "pending") {
    return { severity: "warning", text: r.ledgerStatus === "completed" ? `${says}. Ledger says completed but Paystack has not finished it yet; re-verify later (needs-attention means act at the Paystack dashboard).` : `${says}. Still in progress at Paystack.` }
  }
  return { severity: "warning", text: r.message ? `Could not confirm: ${r.message}` : "Could not confirm the status at Paystack" }
}
