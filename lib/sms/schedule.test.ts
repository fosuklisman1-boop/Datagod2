import { describe, it, expect } from "vitest"
import { checkSchedule, MIN_SCHEDULE_MS, MAX_SCHEDULE_MS } from "./schedule"

const NOW = new Date("2026-10-12T10:00:00.000Z")
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString()

describe("checkSchedule", () => {
  it("accepts a valid mid-range time", () => {
    const r = checkSchedule(iso(3 * 3_600_000), NOW)
    expect(r).toEqual({ ok: true, at: new Date(NOW.getTime() + 3 * 3_600_000) })
  })

  it("accepts exactly MIN ahead", () => {
    expect(checkSchedule(iso(MIN_SCHEDULE_MS), NOW).ok).toBe(true)
  })

  it("rejects MIN - 1 s with the 2-minute message", () => {
    expect(checkSchedule(iso(MIN_SCHEDULE_MS - 1000), NOW)).toEqual({ ok: false, message: "Pick a time at least 2 minutes from now" })
  })

  it("rejects past times", () => {
    expect(checkSchedule(iso(-60_000), NOW)).toEqual({ ok: false, message: "Pick a time at least 2 minutes from now" })
  })

  it("accepts exactly MAX ahead", () => {
    expect(checkSchedule(iso(MAX_SCHEDULE_MS), NOW).ok).toBe(true)
  })

  it("rejects MAX + 1 s with the 30-day message", () => {
    expect(checkSchedule(iso(MAX_SCHEDULE_MS + 1000), NOW)).toEqual({ ok: false, message: "You can schedule up to 30 days ahead" })
  })

  it("accepts an explicit numeric offset", () => {
    // 12:00+01:00 == 11:00Z, one hour after NOW
    const r = checkSchedule("2026-10-12T12:00:00+01:00", NOW)
    expect(r).toEqual({ ok: true, at: new Date("2026-10-12T11:00:00.000Z") })
  })

  it.each([
    ["non-string number", 1760263200000],
    ["null", null],
    ["undefined", undefined],
    ["object", {}],
    ["empty", ""],
    ["whitespace", "   "],
    ["garbage", "not a date"],
    ["no offset", "2026-10-12T12:00:00"],
    ["date only", "2026-10-13"],
    ["invalid calendar date", "2026-13-45T12:00:00Z"],
  ])("rejects %s", (_n, raw) => {
    const r = checkSchedule(raw, NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0)
  })
})
