/** A refund row untouched for this long is no longer considered to have a payout call in flight. */
export const IN_FLIGHT_MS = 5 * 60_000
/** A just-created OTP-gated payout cannot be cancelled for this long (the creating request may still be settling). */
export const FRESH_OTP_MS = 60_000

const ms = (v: string | number | Date): number => (v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v))

/**
 * True when `updatedAt` is at least `thresholdMs` older than `now`. A missing, unparseable or
 * future timestamp is NOT stale: for money code the safe default is "might still be in flight".
 */
export function isStale(updatedAt: string | number | Date | null | undefined, now: string | number | Date, thresholdMs: number): boolean {
  if (updatedAt == null) return false
  const t = ms(updatedAt)
  const n = ms(now)
  if (!Number.isFinite(t) || !Number.isFinite(n)) return false
  return n - t >= thresholdMs
}

/** reserved/processing rows younger than 5 minutes may still have the original payout call running. */
export function isInFlight(r: { status: string; updated_at?: string | null }, now: string | number | Date): boolean {
  return (r.status === "reserved" || r.status === "processing") && !isStale(r.updated_at, now, IN_FLIGHT_MS)
}
