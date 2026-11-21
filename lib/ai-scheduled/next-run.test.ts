import { describe, it, expect, vi, afterEach } from "vitest"
import { computeNextRun } from "./next-run"

afterEach(() => vi.useRealTimers())

describe("computeNextRun", () => {
  it("next_run_shared_helper_matches_previous (cron behaviour)", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-21T10:30:00.000Z")) // a Saturday (6)
    expect(computeNextRun({ schedule_type: "once", run_at_timestamp: "2026-12-01T00:00:00.000Z" }).toISOString()).toBe("2026-12-01T00:00:00.000Z")
    expect(computeNextRun({ schedule_type: "hourly" }).toISOString()).toBe("2026-11-21T11:00:00.000Z")
    expect(computeNextRun({ schedule_type: "daily", run_at_time: "08:00" }).toISOString()).toBe("2026-11-22T08:00:00.000Z")
    expect(computeNextRun({ schedule_type: "daily", run_at_time: "23:00" }).toISOString()).toBe("2026-11-21T23:00:00.000Z")
    // weekly scans offsets 1..7 (never today): Saturday -> next Saturday 08:00 when only 6 is allowed.
    expect(computeNextRun({ schedule_type: "weekly", run_at_time: "08:00", run_on_days: [6] }).toISOString()).toBe("2026-11-28T08:00:00.000Z")
    expect(computeNextRun({ schedule_type: "weekly", run_at_time: "08:00", run_on_days: [1, 3] }).toISOString()).toBe("2026-11-23T08:00:00.000Z")
    // fallback: one hour out
    expect(computeNextRun({ schedule_type: "daily" }).toISOString()).toBe("2026-11-21T11:30:00.000Z")
  })
})
