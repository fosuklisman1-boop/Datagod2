import { describe, it, expect } from "vitest"
import { marginStrategy, recomputeMargin } from "./margin-strategy"

const isCustom = (s: string) => !["user", "admin", "sub_agent", "dealer"].includes(s)

describe("marginStrategy", () => {
  const cases: Array<[string, string, boolean, string]> = [
    ["user", "dealer", false, "legacy"],
    ["dealer", "user", false, "legacy"],
    ["dealer", "admin", false, "none"],
    ["user", "admin", false, "none"],
    ["user", "super", false, "recompute"],
    ["super", "dealer", false, "recompute"],
    ["dealer", "user", true, "recompute"],
    ["dealer", "admin", true, "none"],
  ]
  it.each(cases)("%s -> %s (latestRecompute=%s) = %s", (o, n, latestRecompute, want) => {
    expect(marginStrategy(o, n, { isCustom, latestRecompute })).toBe(want)
  })
})

describe("recomputeMargin", () => {
  it("keeps the selling price: margin + oldBase - newBase", () => {
    expect(recomputeMargin(1, 5, 6)).toEqual({ margin: 0, clamped: false })
    expect(recomputeMargin(1, 6, 4.6)).toEqual({ margin: 2.4, clamped: false })
  })
  it("clamps at 0 and says so", () => {
    expect(recomputeMargin(0.5, 5, 6)).toEqual({ margin: 0, clamped: true })
  })
})
