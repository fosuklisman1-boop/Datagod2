import { describe, it, expect } from "vitest"
import {
  periodRange, shiftPeriod, periodLabel, timeLeftLabel, hasEnded, refreshWindow, parsePeriodQuery, isDay, addDays, monthChunks,
} from "./periods"

const at = (iso: string) => new Date(iso)

describe("periodRange", () => {
  it("daily is the day itself", () => {
    expect(periodRange("daily", "2026-10-26")).toEqual({ start: "2026-10-26", end: "2026-10-26" })
  })
  it("weekly runs Monday to Sunday", () => {
    expect(periodRange("weekly", "2026-10-26")).toEqual({ start: "2026-10-26", end: "2026-11-01" }) // Monday
    expect(periodRange("weekly", "2026-11-01")).toEqual({ start: "2026-10-26", end: "2026-11-01" }) // Sunday
    expect(periodRange("weekly", "2026-01-01")).toEqual({ start: "2025-12-29", end: "2026-01-04" }) // across years
  })
  it("monthly covers the whole month, leap years included", () => {
    expect(periodRange("monthly", "2026-10-15")).toEqual({ start: "2026-10-01", end: "2026-10-31" })
    expect(periodRange("monthly", "2028-02-10")).toEqual({ start: "2028-02-01", end: "2028-02-29" })
  })
  it("yearly covers the year", () => {
    expect(periodRange("yearly", "2026-06-30")).toEqual({ start: "2026-01-01", end: "2026-12-31" })
  })
})

describe("shiftPeriod", () => {
  it("moves by whole periods from the period start", () => {
    expect(shiftPeriod("daily", "2026-03-01", -1)).toBe("2026-02-28")
    expect(shiftPeriod("weekly", "2026-10-29", -1)).toBe("2026-10-19")
    expect(shiftPeriod("monthly", "2026-01-31", -1)).toBe("2025-12-01")
    expect(shiftPeriod("monthly", "2026-12-15", 1)).toBe("2027-01-01")
    expect(shiftPeriod("yearly", "2026-05-05", -1)).toBe("2025-01-01")
  })
})

describe("periodLabel", () => {
  it("matches the screenshot style per kind", () => {
    expect(periodLabel("monthly", periodRange("monthly", "2026-10-26"))).toBe("October 2026")
    expect(periodLabel("daily", periodRange("daily", "2026-10-26"))).toBe("26 October 2026")
    expect(periodLabel("yearly", periodRange("yearly", "2026-10-26"))).toBe("2026")
  })
  it("shortens weeks and handles month and year crossings", () => {
    expect(periodLabel("weekly", periodRange("weekly", "2026-10-14"))).toBe("12 – 18 Oct 2026")
    expect(periodLabel("weekly", periodRange("weekly", "2026-10-26"))).toBe("26 Oct – 1 Nov 2026")
    expect(periodLabel("weekly", periodRange("weekly", "2026-01-01"))).toBe("29 Dec 2025 – 4 Jan 2026")
  })
})

describe("timeLeftLabel", () => {
  const oct = periodRange("monthly", "2026-10-01")
  it("counts today as a day left (the reference shows 6 days left on 26 October)", () => {
    expect(timeLeftLabel("monthly", oct, at("2026-10-26T16:47:00Z"))).toBe("6 days left in October")
  })
  it("says last day on the final day", () => {
    expect(timeLeftLabel("monthly", oct, at("2026-10-31T09:00:00Z"))).toBe("Last day of October")
    expect(timeLeftLabel("weekly", periodRange("weekly", "2026-11-01"), at("2026-11-01T09:00:00Z"))).toBe("Last day of the week")
    expect(timeLeftLabel("yearly", periodRange("yearly", "2026-01-01"), at("2026-12-31T09:00:00Z"))).toBe("Last day of 2026")
  })
  it("words weeks and years", () => {
    expect(timeLeftLabel("weekly", periodRange("weekly", "2026-10-26"), at("2026-10-26T09:00:00Z"))).toBe("7 days left this week")
    expect(timeLeftLabel("yearly", periodRange("yearly", "2026-01-01"), at("2026-10-26T09:00:00Z"))).toBe("67 days left in 2026")
  })
  it("counts hours for a day", () => {
    const day = periodRange("daily", "2026-10-26")
    expect(timeLeftLabel("daily", day, at("2026-10-26T19:00:00Z"))).toBe("5 hours left today")
    expect(timeLeftLabel("daily", day, at("2026-10-26T23:30:00Z"))).toBe("Less than an hour left today")
  })
  it("is null outside the period", () => {
    expect(timeLeftLabel("monthly", oct, at("2026-11-01T00:00:00Z"))).toBeNull()
    expect(timeLeftLabel("monthly", oct, at("2026-09-30T23:59:59Z"))).toBeNull()
  })
})

describe("hasEnded", () => {
  it("flips at Accra midnight after the last day", () => {
    const oct = periodRange("monthly", "2026-10-01")
    expect(hasEnded(oct, at("2026-10-31T23:59:59Z"))).toBe(false)
    expect(hasEnded(oct, at("2026-11-01T00:00:00Z"))).toBe(true)
  })
})

describe("refreshWindow", () => {
  it("is yesterday and today during the day", () => {
    expect(refreshWindow(at("2026-10-26T14:05:00Z"))).toEqual({ start: "2026-10-25", end: "2026-10-26" })
  })
  it("widens to 8 days just after midnight", () => {
    expect(refreshWindow(at("2026-10-26T00:04:00Z"))).toEqual({ start: "2026-10-19", end: "2026-10-26" })
    expect(refreshWindow(at("2026-10-26T00:10:00Z"))).toEqual({ start: "2026-10-25", end: "2026-10-26" })
  })
})

describe("parsePeriodQuery", () => {
  const now = at("2026-10-26T12:00:00Z")
  it("defaults to the current period", () => {
    expect(parsePeriodQuery("monthly", undefined, now)).toEqual({ kind: "monthly", range: { start: "2026-10-01", end: "2026-10-31" } })
  })
  it("accepts a past anchor", () => {
    expect(parsePeriodQuery("weekly", "2026-09-02", now)?.range).toEqual({ start: "2026-08-31", end: "2026-09-06" })
  })
  it("rejects unknown kinds, bad days and the future", () => {
    for (const [k, a] of [["hourly", undefined], ["monthly", "2026-02-30"], ["monthly", "26-10-2026"], ["daily", "2026-10-27"], ["yearly", "2019-12-31"], [7, undefined]] as const) {
      expect(parsePeriodQuery(k, a, now)).toBeNull()
    }
  })
})

describe("monthChunks", () => {
  it("splits on month boundaries and keeps partial ends", () => {
    expect(monthChunks({ start: "2026-01-15", end: "2026-03-10" })).toEqual([
      { start: "2026-01-15", end: "2026-01-31" },
      { start: "2026-02-01", end: "2026-02-28" },
      { start: "2026-03-01", end: "2026-03-10" },
    ])
  })
  it("returns one chunk inside a month and none for an empty range", () => {
    expect(monthChunks({ start: "2026-10-26", end: "2026-10-26" })).toEqual([{ start: "2026-10-26", end: "2026-10-26" }])
    expect(monthChunks({ start: "2026-10-27", end: "2026-10-26" })).toEqual([])
  })
})

describe("day helpers", () => {
  it("validate real calendar days", () => {
    expect(isDay("2028-02-29")).toBe(true)
    expect(isDay("2026-02-29")).toBe(false)
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
  })
})
