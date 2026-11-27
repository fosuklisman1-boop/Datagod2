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

/** A live (waiting or admitted) ticket as the routes read it, oldest first. */
export interface LiveTicket {
  id: string
  user_id: string | null
  device_hash: string | null
  status: "waiting" | "admitted"
  created_at: string
}

/** A signed-in caller owns tickets by user id; a visitor by device hash. The two never cross. */
export function ownsTicket(t: Pick<LiveTicket, "user_id" | "device_hash">, who: { userId?: string; deviceHash: string | null }): boolean {
  if (who.userId) return t.user_id === who.userId
  return !!who.deviceHash && t.user_id === null && t.device_hash === who.deviceHash
}

/** 1-based place in the line among waiting tickets (oldest first list); 0 when not waiting. */
export function waitingPosition(live: LiveTicket[], id: string): number {
  const waiting = live.filter((t) => t.status === "waiting")
  const at = waiting.findIndex((t) => t.id === id)
  return at < 0 ? 0 : at + 1
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
