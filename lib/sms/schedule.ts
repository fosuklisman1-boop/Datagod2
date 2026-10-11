/**
 * Scheduled-send bounds (Phase 4a). A send may be scheduled from 2 minutes to 30 days ahead.
 * Pure: the routes validate with this BEFORE any DB write.
 */
export const MIN_SCHEDULE_MS = 2 * 60_000
export const MAX_SCHEDULE_MS = 30 * 24 * 3_600_000

export type ScheduleCheck = { ok: true; at: Date } | { ok: false; message: string }

const INVALID_MESSAGE = "Send a valid date and time with a timezone (ISO 8601, e.g. 2026-10-12T14:30:00Z)"
// Full date + time + an EXPLICIT offset (Z or ±HH:MM). A bare local time is ambiguous → rejected.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i

export function checkSchedule(raw: unknown, now: Date = new Date()): ScheduleCheck {
  if (typeof raw !== "string") return { ok: false, message: INVALID_MESSAGE }
  const s = raw.trim()
  if (!ISO_WITH_OFFSET.test(s)) return { ok: false, message: INVALID_MESSAGE }
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) return { ok: false, message: INVALID_MESSAGE }
  const ahead = ms - now.getTime()
  if (ahead < MIN_SCHEDULE_MS) return { ok: false, message: "Pick a time at least 2 minutes from now" }
  if (ahead > MAX_SCHEDULE_MS) return { ok: false, message: "You can schedule up to 30 days ahead" }
  return { ok: true, at: new Date(ms) }
}
