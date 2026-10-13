/**
 * Manual Hubtel balance (design 2026-10-12 §B): a stop-gap while the relay /balance is blocked.
 * The admin types the Hubtel SMS wallet balance (NOT the Disbursement wallet the relay reads) shown in
 * the Hubtel dashboard; the app then estimates
 * the live balance as amount − (Hubtel SMS spend recorded since). Pure helpers only — no I/O here,
 * so routing.ts and platform-settings.ts can import it without cycles.
 *
 * Stored in tenant_global_settings under `sms_hubtel_manual_balance` as { amountGhs, setAt, setBy },
 * written ONLY by the admin settings API (server-stamped setAt / setBy). A cleared value is stored
 * as { amountGhs: null, ... } and parses to null.
 */

export interface HubtelManualBalance {
  amountGhs: number
  /** ISO timestamp, server-stamped when the admin saved it. */
  setAt: string
  /** Admin user id who saved it. */
  setBy: string
}

export const HUBTEL_MANUAL_BALANCE_KEY = "sms_hubtel_manual_balance"
/** Boolean: use the manual balance even when the relay works (the relay reads a different Hubtel wallet). */
export const HUBTEL_PREFER_MANUAL_KEY = "sms_hubtel_prefer_manual_balance"
export const MANUAL_BALANCE_MAX_GHS = 1_000_000
/** A manual balance older than this is ignored everywhere (solvency gate, snapshot, primary switch). */
export const MANUAL_BALANCE_MAX_AGE_MS = 30 * 86_400_000
/** Tolerated forward clock skew for setAt; anything further ahead is not trusted. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000

/** Tolerant parse: any invalid shape is ignored (null), never thrown. */
export function parseHubtelManualBalance(v: unknown): HubtelManualBalance | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const raw = o.amountGhs
  const amount = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : NaN
  if (!Number.isFinite(amount) || amount < 0 || amount > MANUAL_BALANCE_MAX_GHS) return null
  if (typeof o.setAt !== "string" || !Number.isFinite(Date.parse(o.setAt))) return null
  if (typeof o.setBy !== "string" || !o.setBy.trim()) return null
  return { amountGhs: amount, setAt: o.setAt, setBy: o.setBy }
}

/** True when a manual balance exists, is younger than 30 days and not (meaningfully) in the future. */
export function isManualBalanceFresh(mb: HubtelManualBalance | null | undefined, now = Date.now()): boolean {
  if (!mb) return false
  const at = Date.parse(mb.setAt)
  if (!Number.isFinite(at)) return false
  const age = now - at
  return age > -MAX_FUTURE_SKEW_MS && age < MANUAL_BALANCE_MAX_AGE_MS
}

/**
 * amount − spent, floored at 0 (so it never exceeds the entered amount either).
 * Throws on a negative / non-finite spend: the caller must treat that as "balance unavailable",
 * never as "nothing spent".
 */
export function manualEstimate(amountGhs: number, spentGhs: number): number {
  if (!Number.isFinite(spentGhs) || spentGhs < 0) throw new Error(`invalid Hubtel spend: ${String(spentGhs)}`)
  if (!Number.isFinite(amountGhs) || amountGhs <= 0) return 0
  return Math.max(0, Math.min(amountGhs, amountGhs - spentGhs))
}
