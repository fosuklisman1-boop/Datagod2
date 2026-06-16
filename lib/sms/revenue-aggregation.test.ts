import { describe, it, expect } from "vitest"
import { aggregateRevenue, type RawRevenueSums } from "./revenue-aggregation"

const zero: RawRevenueSums = {
  activationCount: null,
  activationTotal: null,
  bundleUnitsSold: null,
  bundleGhsTotal: null,
}

describe("aggregateRevenue", () => {
  it("all-null inputs → all zeros (no NaN)", () => {
    const out = aggregateRevenue(zero)
    expect(out).toEqual({ activations: 0, activationTotal: 0, bundleTotal: 0, creditsSold: 0 })
  })

  it("maps populated fields correctly", () => {
    const raw: RawRevenueSums = {
      activationCount: 12,
      activationTotal: 240,
      bundleUnitsSold: 55000,
      bundleGhsTotal: 1650,
    }
    expect(aggregateRevenue(raw)).toEqual({
      activations: 12,
      activationTotal: 240,
      bundleTotal: 1650,
      creditsSold: 55000,
    })
  })

  it("numeric strings from Postgres coerce correctly", () => {
    // Supabase sometimes returns numeric columns as strings.
    const raw = {
      activationCount: 3,
      activationTotal: "75.00" as unknown as number,
      bundleUnitsSold: "5000" as unknown as number,
      bundleGhsTotal: "150.00" as unknown as number,
    }
    const out = aggregateRevenue(raw)
    expect(out.activationTotal).toBe(75)
    expect(out.creditsSold).toBe(5000)
    expect(out.bundleTotal).toBe(150)
  })

  it("zero counts are preserved (not collapsed to null)", () => {
    const raw: RawRevenueSums = { activationCount: 0, activationTotal: 0, bundleUnitsSold: 0, bundleGhsTotal: 0 }
    expect(aggregateRevenue(raw)).toEqual({ activations: 0, activationTotal: 0, bundleTotal: 0, creditsSold: 0 })
  })
})
