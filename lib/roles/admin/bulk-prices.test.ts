import { describe, it, expect } from "vitest"
import { bulkFromPublic, bulkFromRole } from "./bulk-prices"

describe("bulkFromPublic", () => {
  it("applies percent off rounded to 2dp", () => {
    expect(bulkFromPublic([{ id: "a", price: 10 }], 15).changes[0].price).toBe(8.5)
    expect(bulkFromPublic([{ id: "a", price: 3.33 }], 10)).toEqual({ changes: [{ package_id: "a", price: 3 }], skipped: [] })
  })
  it("100% off skips; tiny results skip", () => {
    expect(bulkFromPublic([{ id: "a", price: 10 }], 100)).toEqual({ changes: [], skipped: ["a"] })
    expect(bulkFromPublic([{ id: "a", price: 0.01 }], 80)).toEqual({ changes: [], skipped: ["a"] })
  })
  it("0% keeps price", () => {
    expect(bulkFromPublic([{ id: "a", price: 7.25 }], 0).changes[0].price).toBe(7.25)
  })
  it("throws on bad percent", () => {
    for (const p of [-1, 100.5, NaN, Infinity]) expect(() => bulkFromPublic([], p)).toThrow()
  })
})

describe("bulkFromRole", () => {
  it("adds delta, rounds, skips <= 0", () => {
    const src = new Map([["a", 10], ["b", 1], ["c", 2.5]])
    expect(bulkFromRole(src, -1)).toEqual({ changes: [{ package_id: "a", price: 9 }, { package_id: "c", price: 1.5 }], skipped: ["b"] })
    expect(bulkFromRole(new Map([["a", 1.1]]), 0.2).changes[0].price).toBe(1.3)
  })
  it("throws on non-finite delta", () => {
    expect(() => bulkFromRole(new Map(), NaN)).toThrow()
    expect(() => bulkFromRole(new Map(), Infinity)).toThrow()
  })
})
