import { openSessions, nextSlotFreeAt, MAX_OPEN_SESSIONS, WINDOW_MINUTES, type SessionLite } from "./window"
// MAX_OPEN_SESSIONS also used in customer copy below

/** "GH₵ 10,000" for whole amounts, "GH₵ 2,000.50" otherwise; `fixed` forces 2 decimals. */
export function formatGhs(value: number, opts: { fixed?: boolean } = {}): string {
  const whole = Number.isInteger(value)
  const digits = opts.fixed || !whole ? 2 : 0
  const body = value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return `GH₵ ${body}`
}

/** Amber notice headline: min (2dp) and max (compact). */
export function limitsLine(limits: { minNet: number; maxSent: number }): string {
  return `Minimum ${formatGhs(limits.minNet, { fixed: true })} · Maximum ${formatGhs(limits.maxSent)}`
}

/** Plain-text pieces of the "Before you send" box (numbers are bolded by the component). */
export function beforeYouSendLines(limits: { minNet: number; maxSent: number }) {
  return {
    window: `Your payment details stay valid for ${WINDOW_MINUTES} minutes.`,
    between: `Send between ${formatGhs(limits.minNet, { fixed: true })} and ${formatGhs(limits.maxSent)}.`,
  }
}

/** Copy for the "Top-ups are paused" panel on the Top Up Wallet tab. */
export function pausedPanelCopy(sendAndClaimEnabled: boolean) {
  const base = "Card and MoMo top-ups are temporarily unavailable."
  return {
    title: "Top-ups are paused",
    text: sendAndClaimEnabled
      ? `${base} You can still fund your wallet instantly with Send & Claim.`
      : `${base} Please check back soon.`,
    showButton: sendAndClaimEnabled,
  }
}

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
    case "feature_off":
      return "Send & Claim is not available right now."
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
