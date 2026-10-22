import { describe, it, expect } from "vitest"
import { DEFAULT_LIMITS, resolveLimit, parseLimitOverrides } from "./limits"

describe("resolveLimit", () => {
  it("has the documented defaults", () => {
    expect(DEFAULT_LIMITS).toEqual({ purchase: 10, bulk: 3, balance: 30, status: 30 })
  })

  it("uses the default with no overrides", () => {
    expect(resolveLimit("purchase", null)).toBe(10)
    expect(resolveLimit("purchase", undefined)).toBe(10)
  })

  it("uses a valid override", () => {
    expect(resolveLimit("purchase", { purchase: 25 })).toBe(25)
  })

  it("falls back to the default for corrupt overrides", () => {
    expect(resolveLimit("purchase", { purchase: -1 })).toBe(10)
    expect(resolveLimit("purchase", { purchase: "x" })).toBe(10)
    expect(resolveLimit("purchase", { purchase: 1.5 })).toBe(10)
    expect(resolveLimit("purchase", "garbage")).toBe(10)
  })
})

describe("parseLimitOverrides", () => {
  it("rejects out-of-range values", () => {
    expect(parseLimitOverrides({ bulk: 0 }).ok).toBe(false)
    expect(parseLimitOverrides({ bulk: 10001 }).ok).toBe(false)
  })

  it("accepts a valid value", () => {
    expect(parseLimitOverrides({ bulk: 5 })).toEqual({ ok: true, value: { bulk: 5 } })
  })

  it("rejects unknown groups", () => {
    expect(parseLimitOverrides({ foo: 5 }).ok).toBe(false)
  })

  it("accepts an empty object", () => {
    expect(parseLimitOverrides({})).toEqual({ ok: true, value: {} })
  })

  it("rejects non-objects", () => {
    expect(parseLimitOverrides(null).ok).toBe(false)
    expect(parseLimitOverrides([1]).ok).toBe(false)
  })
})
