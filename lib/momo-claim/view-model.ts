import { openSessions, nextSlotFreeAt, MAX_OPEN_SESSIONS, type SessionLite } from "./window"
// MAX_OPEN_SESSIONS also used in customer copy below

export type SendAndClaimView<T extends SessionLite> = {
  boxes: T[]
  generateDisabled: boolean
  nextSlotFreeAt: Date | null
  guideOpenByDefault: boolean
}

export type MomoLimits = { minNet: number; maxSent: number }

/** Customer copy for POST /api/wallet/momo-sessions error codes. */
export function momoErrorCopy(code: string | undefined, limits: MomoLimits): string {
  switch (code) {
    case "phone_not_verified":
      return "Verify your phone number to use Send & Claim."
    case "no_wallet":
      return "Your wallet isn't ready yet. Refresh the page or contact support."
    case "below_min":
      return `Amount too small. The minimum after the fee is GHS ${limits.minNet.toFixed(2)}.`
    case "above_max":
      return `Amount too large. The maximum per payment is GHS ${limits.maxSent.toFixed(2)}.`
    case "invalid":
      return "Enter a valid amount (up to 2 decimals)."
    case "too_many_open":
      return `You have ${MAX_OPEN_SESSIONS} open payments. A new one unlocks when one expires or is credited.`
    case "rate_limited":
      return "Please wait a moment and try again."
    default:
      return "Something went wrong. Please try again."
  }
}

/** Pure view state for the Send & Claim tab. Client-safe (no server imports). */
export function buildSendAndClaimView<T extends SessionLite>(
  sessions: T[],
  now: Date,
  modalOpen: boolean,
  hasCredited: boolean,
): SendAndClaimView<T> {
  const open = openSessions(sessions, now) as T[]
  const next = nextSlotFreeAt(sessions, now)
  return {
    boxes: modalOpen ? [] : open,
    generateDisabled: open.length >= MAX_OPEN_SESSIONS,
    nextSlotFreeAt: next,
    guideOpenByDefault: !hasCredited,
  }
}
