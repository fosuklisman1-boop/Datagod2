import { openSessions, nextSlotFreeAt, MAX_OPEN_SESSIONS, type SessionLite } from "./window"
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

/** True when the open payment modal should close: its session was credited/cancelled, or its window ran out. */
export function shouldCloseModal(
  modal: { sessionId: string; expiresAt: string } | null,
  sessions: { id: string; status: string }[],
  nowMs: number,
): boolean {
  if (!modal) return false
  if (nowMs >= new Date(modal.expiresAt).getTime()) return true
  const s = sessions.find((x) => x.id === modal.sessionId)
  return !!s && s.status !== "pending"
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
      return `Amount too small. The minimum after the fee is GH₵ ${limits.minNet.toFixed(2)}.`
    case "above_max":
      return `Amount too large. The maximum per payment is GH₵ ${limits.maxSent.toFixed(2)}.`
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

/** "mm:ss" until `target`, never negative. Minutes are zero-padded (60 min window). */
export function formatCountdownMmSs(target: string | Date, nowMs: number): string {
  const ms = new Date(target).getTime() - nowMs
  const s = ms > 0 ? Math.floor(ms / 1000) : 0
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "12 Nov 2026, 12:28 am" in the viewer's local time. */
export function formatStartedAt(value: string | Date): string {
  const d = new Date(value)
  const h = d.getHours()
  const h12 = h % 12 === 0 ? 12 : h % 12
  const mm = String(d.getMinutes()).padStart(2, "0")
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${h12}:${mm} ${h < 12 ? "am" : "pm"}`
}

/** Pieces of "You have **n** of 5 payments open." (the count is bolded by the component). */
export function openPaymentsLine(n: number) {
  return { lead: "You have", count: String(n), rest: `of ${MAX_OPEN_SESSIONS} payments open.` }
}

/** Check button gate: a MoMo transaction ID is 8-15 digits. */
export function isValidTransactionId(value: string): boolean {
  return /^\d{8,15}$/.test(value.trim())
}

/** Help text under the read-only amount field. */
export function claimHelpLine(limits: { minNet: number; maxSent: number }): string {
  return `This must match the amount you actually sent. Min ${formatGhs(limits.minNet, { fixed: true })} · Max ${formatGhs(limits.maxSent)}.`
}

/** Plain 2dp number (what the Amount "Copy" button copies). */
export function formatPlainAmount(value: number): string {
  return value.toFixed(2)
}
