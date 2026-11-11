import { describe, it, expect } from "vitest"
import { validateSettings, hasAtMostTwoDecimals } from "./admin-validate"

const GOOD = {
  enabled: true,
  accounts: [{ network: "MTN", number: "0240000000" }],
  accountName: "Datagod Ltd",
  feeCustomerPercent: 2,
  feeDealerPercent: 1,
  minNet: 5,
  maxSent: 2000,
  senderAllowlist: [" MobileMoney "],
  regressionThreshold: 1000000,
  reviewThreshold: 500,
  dailyCap: 3000,
}

describe("validateSettings", () => {
  it("accepts a good body and trims the allowlist", () => {
    const r = validateSettings(GOOD)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.senderAllowlist).toEqual(["MobileMoney"])
  })

  it.each([
    ["enabled", { enabled: "true" }],
    ["accounts", { accounts: "x" }],
    ["accounts", { accounts: [{ network: "Vodafone", number: "0240000000" }] }],
    ["accounts", { accounts: [{ network: "MTN", number: "240000000" }] }],
    ["accounts", { accounts: [{ network: "MTN", number: "02400000001" }] }],
    ["accountName", { accountName: "x".repeat(81) }],
    ["accountName", { accountName: 5 }],
    ["feeCustomerPercent", { feeCustomerPercent: "2" }],
    ["feeCustomerPercent", { feeCustomerPercent: 100.5 }],
    ["feeCustomerPercent", { feeCustomerPercent: -1 }],
    ["feeDealerPercent", { feeDealerPercent: "1" }],
    ["feeDealerPercent", { feeDealerPercent: NaN }],
    ["minNet", { minNet: -1 }],
    ["minNet", { minNet: "5" }],
    ["maxSent", { maxSent: 4 }],
    ["senderAllowlist", { senderAllowlist: [] }],
    ["senderAllowlist", { senderAllowlist: ["  "] }],
    ["senderAllowlist", { senderAllowlist: ["x".repeat(41)] }],
    ["senderAllowlist", { senderAllowlist: [5] }],
    ["regressionThreshold", { regressionThreshold: 1.5 }],
    ["regressionThreshold", { regressionThreshold: -1 }],
    ["reviewThreshold", { reviewThreshold: -1 }],
    ["dailyCap", { dailyCap: "3000" }],
  ])("rejects bad %s", (field, patch) => {
    const r = validateSettings({ ...GOOD, ...patch })
    expect(r).toEqual({ ok: false, field })
  })

  it("accepts boundary values", () => {
    const r = validateSettings({ ...GOOD, feeCustomerPercent: 0, feeDealerPercent: 100, minNet: 0, maxSent: 0, accountName: "", regressionThreshold: 0, reviewThreshold: 0, dailyCap: 0 })
    expect(r.ok).toBe(true)
  })

  it("rejects non-objects", () => {
    expect(validateSettings(null).ok).toBe(false)
    expect(validateSettings([]).ok).toBe(false)
  })
})

describe("hasAtMostTwoDecimals", () => {
  it("works", () => {
    expect(hasAtMostTwoDecimals(10.25)).toBe(true)
    expect(hasAtMostTwoDecimals(0.1 + 0.2)).toBe(true)
    expect(hasAtMostTwoDecimals(10.123)).toBe(false)
  })
})
