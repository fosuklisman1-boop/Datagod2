import { isStale, isInFlight, IN_FLIGHT_MS, FRESH_OTP_MS } from "./staleness"

const NOW = Date.parse("2026-10-05T12:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe("isStale", () => {
  it("is false when younger than the threshold, true at/after it", () => {
    expect(isStale(ago(4 * 60_000 + 59_000), NOW, IN_FLIGHT_MS)).toBe(false)
    expect(isStale(ago(IN_FLIGHT_MS), NOW, IN_FLIGHT_MS)).toBe(true)
    expect(isStale(ago(IN_FLIGHT_MS + 1), NOW, IN_FLIGHT_MS)).toBe(true)
  })
  it("accepts Date for now and updated_at", () => {
    expect(isStale(new Date(NOW - 10 * 60_000), new Date(NOW), IN_FLIGHT_MS)).toBe(true)
  })
  it("treats a missing / unparseable timestamp as NOT stale (fail safe)", () => {
    expect(isStale(null, NOW, IN_FLIGHT_MS)).toBe(false)
    expect(isStale(undefined, NOW, IN_FLIGHT_MS)).toBe(false)
    expect(isStale("garbage", NOW, IN_FLIGHT_MS)).toBe(false)
  })
  it("treats a timestamp in the future (clock skew) as not stale", () => {
    expect(isStale(ago(-60_000), NOW, IN_FLIGHT_MS)).toBe(false)
  })
})

describe("isInFlight", () => {
  it("reserved/processing younger than 5 min are in flight; older are not", () => {
    expect(isInFlight({ status: "reserved", updated_at: ago(60_000) }, NOW)).toBe(true)
    expect(isInFlight({ status: "processing", updated_at: ago(60_000) }, NOW)).toBe(true)
    expect(isInFlight({ status: "processing", updated_at: ago(IN_FLIGHT_MS + 1000) }, NOW)).toBe(false)
  })
  it("other statuses are never in flight", () => {
    for (const status of ["awaiting_otp", "completed", "failed"]) expect(isInFlight({ status, updated_at: ago(1000) }, NOW)).toBe(false)
  })
  it("fresh OTP window is 60s", () => {
    expect(FRESH_OTP_MS).toBe(60_000)
  })
})
