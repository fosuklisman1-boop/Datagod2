// Live delivery estimate: the pure formulas. No database, no server-only imports, so the dashboard widget
// can re-run the same maths in the browser every second while an order is still open, and every rule here
// is unit tested without a database (lib/delivery-estimate/compute.test.ts).
//
// We never average history. Two reference orders per channel:
//   C = the most recently PLACED completed order (by created_at, never by when it finished), so an old
//       straggler that resolves late can't pose as "the latest".
//   P = the OLDEST still-open (in-flight) order placed at or after C was placed. Anchored to C's created_at,
//       not its completion time, so a sibling placed moments before C finished is still caught.
// Metric 1 ("last order took")   = C.completedAt - C.createdAt
// Metric 2 ("current estimate")  = now - P.createdAt, ticking live; falls back to Metric 1 when there is no P.

/** Normal confirmation/webhook overhead that isn't the customer waiting. Tune to the real lag. */
export const BUFFER_MINUTES = 5
/** A C older than this, with nothing newer, means "no recent orders" rather than a number. */
export const STALE_HOURS = 24

export type HeadlineKey = "instant" | "ongoing" | "working"
export type StrengthTier = "Excellent" | "Good" | "Delayed" | "Critical"
export type EstimateState = "live" | "no_recent" | "no_data" | "down"

export const HEADLINE_TEXT: Record<HeadlineKey, string> = {
  instant: "Instant Delivery Ongoing",
  ongoing: "Delivery Ongoing",
  // Never "slow" or "down": the order is genuinely still being worked on.
  working: "Validation Ongoing",
}

export interface ReferenceOrder { createdAt: string; completedAt: string }
export interface OpenOrder { createdAt: string }

export interface ChannelOverride {
  isManuallyDown: boolean
  reason: string | null
  since: string | null
  /** Numbers captured when the channel was marked down; shown frozen instead of recomputing. */
  frozen: FrozenNumbers | null
}

export interface FrozenNumbers {
  lastOrderSeconds: number | null
  currentSeconds: number | null
  lastOrder: ReferenceOrder | null
}

export interface ChannelEstimate {
  state: EstimateState
  /** C, when there is one (also shown while down, from the frozen snapshot). */
  lastOrder: ReferenceOrder | null
  /** Metric 1 after the buffer, in seconds (precise; never pre-rounded). */
  lastOrderSeconds: number | null
  /** P's placement time while it is still open: the client ticks Metric 2 from this. Null = no open order. */
  openSince: string | null
  /** Metric 2 after the buffer, in seconds, as of `computedAt`. */
  currentSeconds: number | null
  headline: { key: HeadlineKey; text: string } | null
  strength: { percent: number; tier: StrengthTier } | null
  override: { reason: string | null; since: string | null } | null
  computedAt: string
}

const ms = (iso: string) => Date.parse(iso)

/** Seconds between two instants, never negative (clock skew between DB rows must not show a negative wait). */
export function secondsBetween(startIso: string, endIso: string): number {
  return Math.max(0, (ms(endIso) - ms(startIso)) / 1000)
}

/** `adjusted = raw <= BUFFER ? raw : raw - BUFFER`, in seconds. */
export function applyBuffer(rawSeconds: number, bufferMinutes = BUFFER_MINUTES): number {
  const buffer = bufferMinutes * 60
  return rawSeconds <= buffer ? rawSeconds : rawSeconds - buffer
}

/** Headline from the adjusted Metric 2: under 10 min instant, under 60 ongoing, else still being worked on. */
export function headlineFor(adjustedSeconds: number): { key: HeadlineKey; text: string } {
  const minutes = adjustedSeconds / 60
  const key: HeadlineKey = minutes < 10 ? "instant" : minutes < 60 ? "ongoing" : "working"
  return { key, text: HEADLINE_TEXT[key] }
}

// Piecewise-linear strength over the adjusted Metric 1 (minutes): [minutes, percent] knots, interpolated
// between neighbours so the bar never jumps in big steps. Floor of 1%: a working channel never shows 0.
const KNOTS: ReadonlyArray<readonly [number, number]> = [[10, 100], [30, 80], [60, 50], [180, 20], [720, 1]]

export function strengthFor(adjustedSeconds: number): { percent: number; tier: StrengthTier } {
  const minutes = adjustedSeconds / 60
  const tier: StrengthTier = minutes <= 30 ? "Excellent" : minutes <= 60 ? "Good" : minutes <= 180 ? "Delayed" : "Critical"
  let percent: number
  if (minutes <= KNOTS[0][0]) percent = KNOTS[0][1]
  else if (minutes >= KNOTS[KNOTS.length - 1][0]) percent = KNOTS[KNOTS.length - 1][1]
  else {
    const i = KNOTS.findIndex(([m]) => minutes <= m)
    const [m0, p0] = KNOTS[i - 1]
    const [m1, p1] = KNOTS[i]
    percent = p0 + ((minutes - m0) / (m1 - m0)) * (p1 - p0)
  }
  // Keep each tier inside its own band: the knot values sit exactly on tier edges (e.g. 30 min is 80%,
  // still Excellent; just past it Good starts at 79%).
  const band: Record<StrengthTier, [number, number]> = { Excellent: [80, 100], Good: [50, 79], Delayed: [20, 49], Critical: [1, 19] }
  const [lo, hi] = band[tier]
  return { percent: Math.min(hi, Math.max(lo, Math.round(percent))), tier }
}

/**
 * Human duration. Branches on the PRECISE seconds, never on rounded minutes: a real 31-59 s value must read
 * "45 sec", not round up to "1 min", and nothing ever reads "0 sec" / "0 min".
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`
}

/** Metric 2 for an open P at `now`, after the buffer. */
export function currentSecondsAt(openSince: string, now: string): number {
  return applyBuffer(secondsBetween(openSince, now))
}

/**
 * The one place C/P become numbers. `c`/`p` come from lib/delivery-estimate/query.ts (or a test).
 * A down override freezes the last-known numbers, zeroes strength and drops the headline.
 */
export function computeEstimate(input: { c: ReferenceOrder | null; p: OpenOrder | null; now: string; override?: ChannelOverride | null }): ChannelEstimate {
  const { c, p, now, override } = input
  const base = { computedAt: now, override: null as ChannelEstimate["override"] }

  if (override?.isManuallyDown) {
    const f = override.frozen
    return {
      ...base, state: "down",
      lastOrder: f?.lastOrder ?? null, lastOrderSeconds: f?.lastOrderSeconds ?? null,
      openSince: null, currentSeconds: f?.currentSeconds ?? null,
      headline: null, strength: { percent: 0, tier: "Critical" },
      override: { reason: override.reason, since: override.since },
    }
  }
  if (!c) {
    return { ...base, state: "no_data", lastOrder: null, lastOrderSeconds: null, openSince: null, currentSeconds: null, headline: null, strength: null }
  }

  const lastOrderSeconds = applyBuffer(secondsBetween(c.createdAt, c.completedAt))
  // Stale: C placed more than STALE_HOURS ago and nothing open since (P would be newer than C).
  if (!p && ms(now) - ms(c.createdAt) > STALE_HOURS * 3600_000) {
    return { ...base, state: "no_recent", lastOrder: c, lastOrderSeconds, openSince: null, currentSeconds: null, headline: null, strength: null }
  }

  const currentSeconds = p ? currentSecondsAt(p.createdAt, now) : lastOrderSeconds
  return {
    ...base, state: "live",
    lastOrder: c, lastOrderSeconds,
    openSince: p?.createdAt ?? null, currentSeconds,
    headline: headlineFor(currentSeconds),
    strength: strengthFor(lastOrderSeconds),
  }
}

/** Re-derive the live-ticking parts at a later instant (browser timer). Down/no-data states don't move. */
export function tick(e: ChannelEstimate, now: string): ChannelEstimate {
  if (e.state !== "live" || !e.openSince) return e
  const currentSeconds = currentSecondsAt(e.openSince, now)
  return { ...e, currentSeconds, headline: headlineFor(currentSeconds) }
}

/** What to snapshot when an admin marks a channel down. */
export function freeze(e: ChannelEstimate): FrozenNumbers {
  return { lastOrder: e.lastOrder, lastOrderSeconds: e.lastOrderSeconds, currentSeconds: e.currentSeconds }
}

/**
 * Text for a purchase confirmation screen, or null to show nothing. Only a clean "live and healthy" read
 * qualifies: never a number that could discourage someone right before they pay.
 */
export function confirmScreenText(e: ChannelEstimate | null): string | null {
  if (!e || e.state !== "live" || e.currentSeconds === null || !e.headline || !e.strength) return null
  if (e.headline.key === "working") return null
  if (e.strength.tier !== "Excellent" && e.strength.tier !== "Good") return null
  return `Delivery: ~${formatDuration(e.currentSeconds)}`
}
