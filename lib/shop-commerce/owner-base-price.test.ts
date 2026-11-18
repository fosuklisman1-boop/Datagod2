import { describe, expect, it } from "vitest"
import { ownerDisplayBase } from "./owner-base-price"

describe("ownerDisplayBase", () => {
  it("uses the server base map when the package is present", () => {
    expect(ownerDisplayBase({ id: "p1", price: 10 }, { p1: 8 })).toBe(8)
  })

  it("falls back to the public price when the package is missing from the map", () => {
    expect(ownerDisplayBase({ id: "p2", price: 10 }, { p1: 8 })).toBe(10)
  })

  it("falls back to the public price when the map is null", () => {
    expect(ownerDisplayBase({ id: "p1", price: 10 }, null)).toBe(10)
  })

  it("parent_price wins over the base map", () => {
    expect(ownerDisplayBase({ id: "p1", price: 10, parent_price: 9 }, { p1: 8 })).toBe(9)
  })

  it("ignores a null parent_price", () => {
    expect(ownerDisplayBase({ id: "p1", price: 10, parent_price: null }, { p1: 8 })).toBe(8)
  })

  it("coerces a string price", () => {
    expect(ownerDisplayBase({ id: "p1", price: "12.50" }, null)).toBe(12.5)
  })
})
