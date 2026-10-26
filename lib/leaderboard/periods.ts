// Leaderboard periods. Every period is a range of whole Africa/Accra calendar
// days. Accra is UTC+0 all year (no DST), so an Accra day is the UTC date and
// the UTC Date methods below are exact. Days are "YYYY-MM-DD" strings, inclusive.

export type Board = "dashboard" | "shop"
export type PeriodKind = "daily" | "weekly" | "monthly" | "yearly"

export const BOARDS: readonly Board[] = ["dashboard", "shop"]
export const PERIOD_KINDS: readonly PeriodKind[] = ["daily", "weekly", "monthly", "yearly"]

export interface DayRange {
  start: string
  end: string
}

const DAY_MS = 24 * 60 * 60 * 1000
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

function toDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`)
}

function toDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function isDay(value: unknown): value is string {
  return typeof value === "string" && DAY_RE.test(value) && toDay(toDate(value)) === value
}

export function accraDay(now: Date): string {
  return toDay(now)
}

export function addDays(day: string, n: number): string {
  return toDay(new Date(toDate(day).getTime() + n * DAY_MS))
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / DAY_MS)
}

/** The period of `kind` that contains `anchor`. Weeks run Monday to Sunday. */
export function periodRange(kind: PeriodKind, anchor: string): DayRange {
  const d = toDate(anchor)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  switch (kind) {
    case "daily":
      return { start: anchor, end: anchor }
    case "weekly": {
      const start = addDays(anchor, -((d.getUTCDay() + 6) % 7))
      return { start, end: addDays(start, 6) }
    }
    case "monthly":
      return { start: toDay(new Date(Date.UTC(y, m, 1))), end: toDay(new Date(Date.UTC(y, m + 1, 0))) }
    case "yearly":
      return { start: `${y}-01-01`, end: `${y}-12-31` }
  }
}

/** Start day of the period `delta` periods away from the one containing `anchor`. */
export function shiftPeriod(kind: PeriodKind, anchor: string, delta: number): string {
  const { start } = periodRange(kind, anchor)
  const d = toDate(start)
  switch (kind) {
    case "daily":
      return addDays(start, delta)
    case "weekly":
      return addDays(start, 7 * delta)
    case "monthly":
      return toDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1)))
    case "yearly":
      return `${d.getUTCFullYear() + delta}-01-01`
  }
}

function dayParts(day: string): { d: number; month: string; short: string; y: number } {
  const date = toDate(day)
  const month = MONTHS[date.getUTCMonth()]
  return { d: date.getUTCDate(), month, short: month.slice(0, 3), y: date.getUTCFullYear() }
}

/** "26 October 2026", "20 – 26 Oct 2026", "October 2026", "2026". */
export function periodLabel(kind: PeriodKind, range: DayRange): string {
  const s = dayParts(range.start)
  const e = dayParts(range.end)
  switch (kind) {
    case "daily":
      return `${s.d} ${s.month} ${s.y}`
    case "weekly":
      if (s.y !== e.y) return `${s.d} ${s.short} ${s.y} – ${e.d} ${e.short} ${e.y}`
      if (s.short !== e.short) return `${s.d} ${s.short} – ${e.d} ${e.short} ${e.y}`
      return `${s.d} – ${e.d} ${e.short} ${e.y}`
    case "monthly":
      return `${s.month} ${s.y}`
    case "yearly":
      return String(s.y)
  }
}

export function hasEnded(range: DayRange, now: Date): boolean {
  return accraDay(now) > range.end
}

/**
 * Countdown chip text: "6 days left in October", "Last day of the week",
 * "5 hours left today". Today counts as a day left. Null when the period has
 * ended or not started.
 */
export function timeLeftLabel(kind: PeriodKind, range: DayRange, now: Date): string | null {
  const today = accraDay(now)
  if (today > range.end || today < range.start) return null

  if (kind === "daily") {
    const hours = Math.ceil((toDate(addDays(range.end, 1)).getTime() - now.getTime()) / (60 * 60 * 1000))
    if (hours <= 1) return "Less than an hour left today"
    return `${hours} hours left today`
  }

  const days = daysBetween(today, range.end) + 1
  const where = kind === "weekly" ? "this week" : kind === "monthly" ? `in ${dayParts(range.end).month}` : `in ${dayParts(range.end).y}`
  if (days === 1) {
    return kind === "weekly" ? "Last day of the week" : `Last day of ${kind === "monthly" ? dayParts(range.end).month : dayParts(range.end).y}`
  }
  return `${days} days left ${where}`
}

/** Days the refresh cron rebuilds: yesterday and today, widened to the last 8 days in the first 10 minutes after midnight. */
export function refreshWindow(now: Date): DayRange {
  const today = accraDay(now)
  const nightly = now.getUTCHours() === 0 && now.getUTCMinutes() < 10
  return { start: addDays(today, nightly ? -7 : -1), end: today }
}

/** Splits [start, end] into calendar-month chunks (the refresh RPC caps a call at 93 days). */
export function monthChunks(range: DayRange): DayRange[] {
  const chunks: DayRange[] = []
  let start = range.start
  while (start <= range.end) {
    const monthEnd = periodRange("monthly", start).end
    const end = monthEnd < range.end ? monthEnd : range.end
    chunks.push({ start, end })
    start = addDays(end, 1)
  }
  return chunks
}

/**
 * Validates a public period request. The anchor may be any day from 2020 up to
 * today; a missing anchor means the current period.
 */
export function parsePeriodQuery(kind: unknown, anchor: unknown, now: Date): { kind: PeriodKind; range: DayRange } | null {
  if (typeof kind !== "string" || !(PERIOD_KINDS as readonly string[]).includes(kind)) return null
  const today = accraDay(now)
  const day = anchor === undefined || anchor === null || anchor === "" ? today : anchor
  if (!isDay(day) || day > today || day < "2020-01-01") return null
  return { kind: kind as PeriodKind, range: periodRange(kind as PeriodKind, day) }
}
