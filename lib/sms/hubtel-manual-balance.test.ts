import { describe, it, expect } from "vitest"
import { parseHubtelManualBalance, isManualBalanceFresh, manualEstimate, MANUAL_BALANCE_MAX_AGE_MS } from "./hubtel-manual-balance"

const NOW = Date.parse("2026-10-12T12:00:00.000Z")
const good = { amountGhs: 120.5, setAt: "2026-10-12T10:00:00.000Z", setBy: "admin-1" }

describe("parseHubtelManualBalance", () => {
  it("accepts a well-formed value", () => {
    expect(parseHubtelManualBalance(good)).toEqual(good)
  })
  it("accepts a numeric string amount (jsonb round-trips)", () => {
    expect(parseHubtelManualBalance({ ...good, amountGhs: "120.50" })?.amountGhs).toBe(120.5)
  })
  it("accepts zero", () => {
    expect(parseHubtelManualBalance({ ...good, amountGhs: 0 })?.amountGhs).toBe(0)
  })
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 50],
    ["an array", [good]],
    ["a cleared marker", { amountGhs: null, setAt: good.setAt, setBy: "admin-1" }],
    ["a negative amount", { ...good, amountGhs: -1 }],
    ["an amount over 1,000,000", { ...good, amountGhs: 1_000_001 }],
    ["NaN", { ...good, amountGhs: NaN }],
    ["Infinity", { ...good, amountGhs: Infinity }],
    ["a non-numeric string", { ...good, amountGhs: "lots" }],
    ["a missing setAt", { amountGhs: 5, setBy: "a" }],
    ["an unparseable setAt", { ...good, setAt: "yesterday-ish" }],
    ["a missing setBy", { amountGhs: 5, setAt: good.setAt }],
    ["an empty setBy", { ...good, setBy: " " }],
  ])("ignores %s", (_label, v) => {
    expect(parseHubtelManualBalance(v)).toBeNull()
  })
})

describe("isManualBalanceFresh", () => {
  it("is 30 days", () => expect(MANUAL_BALANCE_MAX_AGE_MS).toBe(30 * 86_400_000))
  it("null is never fresh", () => expect(isManualBalanceFresh(null, NOW)).toBe(false))
  it("a value set 2 hours ago is fresh", () => expect(isManualBalanceFresh(good, NOW)).toBe(true))
  it("29 days old is fresh", () => {
    expect(isManualBalanceFresh({ ...good, setAt: new Date(NOW - 29 * 86_400_000).toISOString() }, NOW)).toBe(true)
  })
  it("exactly 30 days old is NOT fresh", () => {
    expect(isManualBalanceFresh({ ...good, setAt: new Date(NOW - 30 * 86_400_000).toISOString() }, NOW)).toBe(false)
  })
  it("31 days old is ignored", () => {
    expect(isManualBalanceFresh({ ...good, setAt: new Date(NOW - 31 * 86_400_000).toISOString() }, NOW)).toBe(false)
  })
  it("a setAt far in the future (clock skew / tampering) is not trusted", () => {
    expect(isManualBalanceFresh({ ...good, setAt: new Date(NOW + 60 * 60_000).toISOString() }, NOW)).toBe(false)
  })
  it("a setAt a few seconds ahead (small skew) is tolerated", () => {
    expect(isManualBalanceFresh({ ...good, setAt: new Date(NOW + 5_000).toISOString() }, NOW)).toBe(true)
  })
})

describe("manualEstimate", () => {
  it("amount minus spend", () => expect(manualEstimate(100, 12.25)).toBeCloseTo(87.75, 10))
  it("floored at 0", () => expect(manualEstimate(10, 25)).toBe(0))
  it("never exceeds the entered amount", () => expect(manualEstimate(10, 0)).toBe(10))
  it("throws on a negative / non-finite spend (fail closed; caller treats as unavailable)", () => {
    expect(() => manualEstimate(10, -1)).toThrow()
    expect(() => manualEstimate(10, NaN)).toThrow()
    expect(() => manualEstimate(10, Infinity)).toThrow()
  })
})
