import { describe, it, expect, vi, afterEach } from "vitest"
import { computeNextRun } from "./next-run"

afterEach(() => vi.useRealTimers())

type T = { schedule_type: string; run_at_time?: string | null; run_on_days?: number[] | null; run_at_timestamp?: string | null }

// Reference oracle 1: the admin scheduled-tasks POST route's original copy (verbatim).
function adminOriginal(task: T): Date {
  const now = new Date()
  if (task.schedule_type === "once") return task.run_at_timestamp ? new Date(task.run_at_timestamp) : now
  if (task.schedule_type === "hourly") {
    const next = new Date(now)
    next.setUTCMinutes(0, 0, 0)
    next.setUTCHours(next.getUTCHours() + 1)
    return next
  }
  if (task.schedule_type === "daily" && task.run_at_time) {
    const [hh, mm] = task.run_at_time.split(":").map(Number)
    const candidate = new Date(now)
    candidate.setUTCHours(hh, mm, 0, 0)
    if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1)
    return candidate
  }
  if (task.schedule_type === "weekly" && task.run_at_time && task.run_on_days?.length) {
    const [hh, mm] = task.run_at_time.split(":").map(Number)
    for (let offset = 0; offset <= 7; offset++) {
      const candidate = new Date(now)
      candidate.setUTCDate(candidate.getUTCDate() + offset)
      candidate.setUTCHours(hh, mm, 0, 0)
      if (task.run_on_days.includes(candidate.getUTCDay()) && candidate > now) return candidate
    }
  }
  return new Date(now.getTime() + 60 * 60 * 1000)
}

// Reference oracle 2: the run-ai-tasks cron's original copy (verbatim).
function cronOriginal(task: T): Date {
  const now = new Date()
  if (task.schedule_type === "once") return task.run_at_timestamp ? new Date(task.run_at_timestamp) : now
  if (task.schedule_type === "hourly") {
    const next = new Date(now)
    next.setUTCMinutes(0, 0, 0)
    next.setUTCHours(next.getUTCHours() + 1)
    return next
  }
  if (task.schedule_type === "daily" && task.run_at_time) {
    const [hh, mm] = task.run_at_time.split(":").map(Number)
    const candidate = new Date(now)
    candidate.setUTCHours(hh, mm, 0, 0)
    if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1)
    return candidate
  }
  if (task.schedule_type === "weekly" && task.run_at_time && task.run_on_days?.length) {
    const [hh, mm] = task.run_at_time.split(":").map(Number)
    for (let offset = 1; offset <= 7; offset++) {
      const candidate = new Date(now)
      candidate.setUTCDate(candidate.getUTCDate() + offset)
      candidate.setUTCHours(hh, mm, 0, 0)
      if (task.run_on_days.includes(candidate.getUTCDay())) return candidate
    }
  }
  return new Date(now.getTime() + 60 * 60 * 1000)
}

// Saturday 2026-11-21 at several clock times, so "before now" and "after now" both occur.
const NOWS = ["2026-11-21T00:00:00.000Z", "2026-11-21T07:59:00.000Z", "2026-11-21T08:00:00.000Z", "2026-11-21T10:30:00.000Z", "2026-11-21T23:59:00.000Z", "2026-11-22T08:01:00.000Z"]
const TASKS: T[] = [
  { schedule_type: "once", run_at_timestamp: "2026-12-01T00:00:00.000Z" },
  { schedule_type: "once", run_at_timestamp: "2026-11-01T00:00:00.000Z" },
  { schedule_type: "once" },
  { schedule_type: "hourly" },
  { schedule_type: "daily", run_at_time: "08:00" },
  { schedule_type: "daily", run_at_time: "23:00" },
  { schedule_type: "daily", run_at_time: "00:00" },
  { schedule_type: "daily" },
  { schedule_type: "weekly", run_at_time: "08:00", run_on_days: [6] },
  { schedule_type: "weekly", run_at_time: "23:00", run_on_days: [6] },
  { schedule_type: "weekly", run_at_time: "08:00", run_on_days: [0, 1, 3] },
  { schedule_type: "weekly", run_at_time: "08:00", run_on_days: [] },
  { schedule_type: "weekly", run_at_time: "08:00" },
]

describe("computeNextRun", () => {
  for (const now of NOWS) {
    it(`next_run_admin_create_matches_old_copy @ ${now}`, () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(now))
      for (const t of TASKS) expect(computeNextRun(t, { includeToday: true }).toISOString(), JSON.stringify(t)).toBe(adminOriginal(t).toISOString())
    })
    it(`next_run_cron_advance_matches_old_copy @ ${now}`, () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(now))
      for (const t of TASKS) expect(computeNextRun(t, { includeToday: false }).toISOString(), JSON.stringify(t)).toBe(cronOriginal(t).toISOString())
    })
  }

  it("the two modes really differ for a weekly task due later today", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-21T07:00:00.000Z")) // Saturday
    const t = { schedule_type: "weekly", run_at_time: "08:00", run_on_days: [6] }
    expect(computeNextRun(t, { includeToday: true }).toISOString()).toBe("2026-11-21T08:00:00.000Z")
    expect(computeNextRun(t, { includeToday: false }).toISOString()).toBe("2026-11-28T08:00:00.000Z")
  })
})
