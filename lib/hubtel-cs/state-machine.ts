import type { HubtelCsPatch, HubtelCsState, HubtelCsTx, ParsedCallback } from "./types"

type StatePatch = HubtelCsPatch & { state: HubtelCsState }
export type Transition =
  | { ignored: string }
  | { next: HubtelCsState; patch: StatePatch; float?: boolean }

export type PostResult = { httpStatus: number; body: unknown } | { error: string }
export interface StatusObservation { ok: boolean; status?: string | null; isFulfilled?: boolean | null }

export const CREATED_STALE_MS = 2 * 60_000
export const PENDING_STALE_MS = 24 * 60 * 60_000
export const NEGATIVE_CONFIRM_AGE_MS = 10 * 60_000
export const NEGATIVE_CONFIRM_COUNT = 2
/** Minimum gap between two status observations that may each count as a negative (cron cadence is 2 min). */
export const RECHECK_GAP_MS = 90_000

export type CodeClass = "success" | "pending" | "unknown" | "float" | "failed"

export function classifyCode(code: unknown, httpStatus?: number): CodeClass {
  const c = typeof code === "string" ? code.trim() : ""
  if (c === "0000") return "success"
  if (c === "0001") return "pending"
  if (c === "" || c === "0005") return "unknown"
  if (c === "4075") return "float"
  // A definite failure must be a well-formed 4-digit code on a non-5xx response; anything else is unknown.
  if (!/^\d{4}$/.test(c)) return "unknown"
  if (httpStatus !== undefined && httpStatus >= 500) return "unknown"
  return "failed"
}

/** Hubtel returns commission as a string with 4 decimals ("0.0198"). */
export function parseCommission(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === "string" && !v.trim()) return null
  const n = typeof v === "number" ? v : Number(String(v).trim())
  return Number.isFinite(n) && n >= 0 ? n : null
}

const textOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const isTerminal = (s: HubtelCsState) => s === "fulfilled" || s === "failed"
const ageMs = (tx: HubtelCsTx, now: Date) => now.getTime() - Date.parse(tx.submitted_at ?? tx.created_at)

export function applyPostResponse(tx: HubtelCsTx, res: PostResult, now: Date): Transition {
  if (tx.state !== "created") return { ignored: `state is ${tx.state}` }
  const ts = now.toISOString()
  if ("error" in res) {
    return { next: "needs_review", patch: { state: "needs_review", updated_at: ts, review_reason: `No response from Hubtel (${res.error}). State unknown - do not resend; check the status first.` } }
  }
  const b = (res.body && typeof res.body === "object" ? res.body : {}) as Record<string, any>
  const data = (b.Data && typeof b.Data === "object" ? b.Data : {}) as Record<string, any>
  const rawCode = typeof b.ResponseCode === "number" ? String(b.ResponseCode) : b.ResponseCode
  const code = typeof rawCode === "string" && rawCode.trim() ? rawCode.trim() : null
  const message = textOrNull(b.Message)
  const base: HubtelCsPatch = {
    response_code: code, response_message: message,
    hubtel_transaction_id: textOrNull(data.TransactionId),
    commission: parseCommission(data.Meta?.Commission),
    submitted_at: ts, updated_at: ts,
  }
  switch (classifyCode(code, res.httpStatus)) {
    case "pending": return { next: "pending", patch: { ...base, state: "pending" } }
    case "success": return { next: "fulfilled", patch: { ...base, state: "fulfilled", completed_at: ts } }
    case "float":
      return { next: "failed", float: true, patch: { ...base, state: "failed", completed_at: ts, failure_reason: "Insufficient Hubtel prepaid balance (4075)" } }
    case "unknown":
      return { next: "needs_review", patch: { ...base, state: "needs_review", review_reason: `Hubtel returned an unknown state (${code ?? "no code"}, HTTP ${res.httpStatus}). Do not resend; check the status first.` } }
    default:
      return { next: "failed", patch: { ...base, state: "failed", completed_at: ts, failure_reason: message ?? `Hubtel error ${code}` } }
  }
}

export function applyCallback(tx: HubtelCsTx, cb: ParsedCallback, now: Date): Transition {
  if (tx.resolved_at) return { ignored: "resolved by admin" }
  if (isTerminal(tx.state)) return { ignored: `already ${tx.state}` }
  const cls = classifyCode(cb.responseCode)
  if (cls === "pending") return { ignored: "interim 0001 callback" }
  const ts = now.toISOString()
  const common: HubtelCsPatch = {
    callback_received_at: ts, updated_at: ts, response_code: cb.responseCode,
    hubtel_transaction_id: textOrNull(cb.transactionId) ?? tx.hubtel_transaction_id,
    external_transaction_id: cb.externalTransactionId ?? tx.external_transaction_id,
    amount_debited: cb.amountDebited ?? tx.amount_debited, charges: cb.charges ?? tx.charges, commission: cb.commission ?? tx.commission,
  }
  if (cls === "success") {
    return { next: "fulfilled", patch: { ...common, state: "fulfilled", completed_at: ts, review_reason: null, failure_reason: null } }
  }
  if (cls === "unknown") {
    return { next: "needs_review", patch: { ...common, state: "needs_review", review_reason: `Hubtel callback reported an unknown state (${cb.responseCode}). Check the status first.` } }
  }
  return {
    next: "failed",
    ...(cls === "float" ? { float: true } : {}),
    patch: { ...common, state: "failed", completed_at: ts, review_reason: null, failure_reason: cb.description ?? `Hubtel code ${cb.responseCode}` },
  }
}

export function applyStatusCheck(tx: HubtelCsTx, obs: StatusObservation, now: Date, opts: { countNegative?: boolean } = {}): Transition {
  if (tx.resolved_at) return { ignored: "resolved by admin" }
  if (tx.state !== "pending" && tx.state !== "needs_review") return { ignored: `state is ${tx.state}` }
  const ts = now.toISOString()
  const age = ageMs(tx, now)
  const base: HubtelCsPatch = { status_check_attempts: tx.status_check_attempts + 1, last_status_check_at: ts, updated_at: ts }
  const open = (extra: HubtelCsPatch = {}): Transition => {
    if (tx.state === "pending" && age >= PENDING_STALE_MS) {
      return { next: "needs_review", patch: { ...base, ...extra, state: "needs_review", review_reason: "Still unresolved 24h after submission - confirm with Hubtel." } }
    }
    return { next: tx.state, patch: { ...base, ...extra, state: tx.state } }
  }
  if (!obs.ok) return open()
  if (obs.isFulfilled === true && String(obs.status ?? "").toLowerCase() === "paid") {
    return { next: "fulfilled", patch: { ...base, state: "fulfilled", completed_at: ts, negative_checks: 0, review_reason: null, failure_reason: null } }
  }
  // Only an UNPAID-style negative counts. Hubtel "Paid" with isFulfilled=false is the money-taken-but-not-yet
  // -delivered window: treated as inconclusive (keep polling), negatives reset to 0, and it can NEVER lead to "failed".
  const paid = String(obs.status ?? "").trim().toLowerCase() === "paid"
  if (obs.isFulfilled === false && !paid) {
    // A caller that re-checks inside the recheck gap records the observation but must not count a second negative.
    if (opts.countNegative === false) return open()
    const neg = tx.negative_checks + 1
    if (neg >= NEGATIVE_CONFIRM_COUNT && age >= NEGATIVE_CONFIRM_AGE_MS) {
      return { next: "failed", patch: { ...base, state: "failed", completed_at: ts, negative_checks: neg, review_reason: null, failure_reason: "Hubtel status check: transaction not fulfilled" } }
    }
    return open({ negative_checks: neg })
  }
  return open({ negative_checks: 0 })
}

export function sweepStale(tx: HubtelCsTx, now: Date): Transition {
  const ts = now.toISOString()
  if (tx.state === "created" && ageMs(tx, now) >= CREATED_STALE_MS) {
    return { next: "needs_review", patch: { state: "needs_review", updated_at: ts, review_reason: "Request never completed (process interrupted before Hubtel replied). State unknown - check the status before any retry." } }
  }
  if (tx.state === "pending" && ageMs(tx, now) >= PENDING_STALE_MS) {
    return { next: "needs_review", patch: { state: "needs_review", updated_at: ts, review_reason: "Still unresolved 24h after submission - confirm with Hubtel." } }
  }
  return { ignored: "not stale" }
}

export function applyResolve(tx: HubtelCsTx, outcome: "fulfilled" | "failed", note: string, adminId: string, now: Date): Transition {
  if (tx.state === outcome) return { ignored: `already ${outcome}` }
  if (tx.state === "created" || tx.state === "pending") return { ignored: `in flight (${tx.state})` }
  const ts = now.toISOString()
  return {
    next: outcome,
    patch: {
      state: outcome, resolved_by: adminId, resolved_at: ts, resolution_note: note, review_reason: null,
      completed_at: tx.completed_at ?? ts,
      failure_reason: outcome === "failed" ? (tx.failure_reason ?? note) : null,
      updated_at: ts,
    },
  }
}
