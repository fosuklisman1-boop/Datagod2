// Waiting line for Clings voice/video calls: pure helpers. No I/O here.
import type { NuanceKey } from "./keys"

/** A waiting ticket whose page has not checked in for this long is dropped (the caller closed the page). */
export const QUEUE_STALE_MS = 20_000
/** An admitted ticket not turned into a call within this long is dropped, so a slot is never held for a ghost. */
export const ADMIT_HOLD_MS = 30_000

/** One call is counted as at most this long when estimating a wait: most calls end sooner. */
const ETA_CALL_CAP_SECONDS = 180

/** Rough wait for a caller at `position` (1-based): whole rounds of `totalSlots` calls ahead, each about as long as a call. */
export function etaSeconds(position: number, totalSlots: number, maxCallSeconds: number): number {
  return Math.ceil(position / Math.max(1, totalSlots)) * Math.min(maxCallSeconds, ETA_CALL_CAP_SECONDS)
}

/** Free call slots now: over every account (account 1 only when multiple accounts are off), callsPerKey minus its open calls. */
export function freeSlotCount(
  accounts: NuanceKey[],
  callsPerKey: number,
  openByKey: Record<number, number>,
  multiAccount: boolean,
): number {
  const used = multiAccount ? accounts : accounts.filter((k) => k.index === 1)
  return used.reduce((sum, k) => sum + Math.max(0, callsPerKey - (openByKey[k.index] ?? 0)), 0)
}
