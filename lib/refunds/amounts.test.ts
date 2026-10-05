import { defaultRefundAmount, validateRefundAmount } from "./amounts"

describe("defaultRefundAmount", () => {
  it("is price minus gateway fee", () => expect(defaultRefundAmount(10, 0.15)).toBe(9.85))
  it("never goes below zero", () => expect(defaultRefundAmount(0.1, 0.5)).toBe(0))
  it("rounds to pesewas", () => expect(defaultRefundAmount(10.005, 0)).toBe(10.01))
})

describe("validateRefundAmount", () => {
  it("accepts a normal and a partial amount", () => {
    expect(validateRefundAmount(9.85, 10)).toBeNull()
    expect(validateRefundAmount(1, 10)).toBeNull()
  })
  it.each([0, -1, NaN, Infinity])("rejects %s", (v) => {
    expect(validateRefundAmount(v as number, 10)).not.toBeNull()
  })
  it("rejects more than was paid", () => expect(validateRefundAmount(10.01, 10)).not.toBeNull())
  it("rejects more than 2 decimals", () => expect(validateRefundAmount(1.005, 10)).not.toBeNull())
})
