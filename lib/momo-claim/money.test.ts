import { describe, it, expect } from "vitest"
import { computeFee, checkSessionAmount } from "./money"

describe("computeFee", () => {
  it("computes a whole fee", () => {
    expect(computeFee(10000, 1.5)).toEqual({ feePesewas: 150, netPesewas: 9850 })
  })
  it("rounds the fee up", () => {
    expect(computeFee(1001, 1.5)).toEqual({ feePesewas: 16, netPesewas: 985 })
  })
  it("zero percent means net equals sent", () => {
    expect(computeFee(5000, 0)).toEqual({ feePesewas: 0, netPesewas: 5000 })
  })
  it("is not fooled by float error (1.1% of 1000)", () => {
    expect(computeFee(1000, 1.1)).toEqual({ feePesewas: 11, netPesewas: 989 })
  })
  it("throws on bad percent", () => {
    expect(() => computeFee(1000, -1)).toThrow()
    expect(() => computeFee(1000, NaN)).toThrow()
    expect(() => computeFee(1000, Infinity)).toThrow()
    expect(() => computeFee(1000, 100.5)).toThrow()
  })
})

describe("checkSessionAmount", () => {
  it("ok inside the range", () => {
    expect(checkSessionAmount(10000, 1.5, 1000, 200000)).toBe("ok")
  })
  it("checks min on the net amount", () => {
    // 1014 sent, 1.5% fee = 16, net 998
    expect(checkSessionAmount(1014, 1.5, 1000, 200000)).toBe("below_min")
    expect(checkSessionAmount(1016, 1.5, 1000, 200000)).toBe("ok")
  })
  it("checks max on the sent amount", () => {
    expect(checkSessionAmount(200001, 1.5, 1000, 200000)).toBe("above_max")
    expect(checkSessionAmount(200000, 1.5, 1000, 200000)).toBe("ok")
  })
  it("rejects invalid amounts", () => {
    expect(checkSessionAmount(10.5, 1.5, 1000, 200000)).toBe("invalid")
    expect(checkSessionAmount(0, 1.5, 1000, 200000)).toBe("invalid")
    expect(checkSessionAmount(-5, 1.5, 1000, 200000)).toBe("invalid")
    expect(checkSessionAmount(NaN, 1.5, 1000, 200000)).toBe("invalid")
    expect(checkSessionAmount(Infinity, 1.5, 1000, 200000)).toBe("invalid")
  })
})
