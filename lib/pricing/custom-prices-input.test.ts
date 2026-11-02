import { describe, it, expect } from "vitest"
import { parseCustomPricesBody, isUuid } from "./custom-prices-input"

const P1 = "11111111-1111-1111-1111-111111111111"
const P2 = P1.replace(/1/g, "2")

describe("parseCustomPricesBody", () => {
  it("accepts a mode alone", () => expect(parseCustomPricesBody({ pricing_mode: "custom" })).toEqual({ ok: true, value: { pricing_mode: "custom", prices: [] } }))
  it("accepts prices and null removals", () => {
    expect(parseCustomPricesBody({ prices: [{ package_id: P1, price: 5.5 }, { package_id: P2, price: null }] })).toEqual({
      ok: true,
      value: { pricing_mode: null, prices: [{ package_id: P1, price: 5.5 }, { package_id: P2, price: null }] },
    })
  })
  it("rejects an empty body", () => expect(parseCustomPricesBody({}).ok).toBe(false))
  it("rejects a bad mode", () => expect(parseCustomPricesBody({ pricing_mode: "vip" }).ok).toBe(false))
  it("rejects bad prices with per-row errors", () => {
    const r = parseCustomPricesBody({ prices: [{ package_id: P1, price: 0 }, { package_id: "x", price: 1 }, { package_id: P1, price: 1.234 }, { package_id: P1, price: 10001 }, { package_id: P1, price: "5" }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["0", "1", "2", "3", "4"])
  })
  it.each([1.1, 2.3, 0.29, 4.35, 10000, 0.01])("accepts %s (float-safe 2 decimals)", (price) => {
    expect(parseCustomPricesBody({ prices: [{ package_id: P1, price }] }).ok).toBe(true)
  })
  it.each([1.234, 0.001, 5.555, 1.000000001, 1e-9])("rejects %s (more than 2 decimals)", (price) => {
    expect(parseCustomPricesBody({ prices: [{ package_id: P1, price }] }).ok).toBe(false)
  })
  it("rejects case-only duplicate packages", () => {
    const lo = "abcdef01-1111-4111-8111-111111111111"
    expect(parseCustomPricesBody({ prices: [{ package_id: lo, price: 1 }, { package_id: lo.toUpperCase(), price: 2 }] }).ok).toBe(false)
  })
  it("rejects a duplicate package", () => expect(parseCustomPricesBody({ prices: [{ package_id: P1, price: 1 }, { package_id: P1, price: 2 }] }).ok).toBe(false))
  it("rejects more than 500 rows", () => expect(parseCustomPricesBody({ prices: Array.from({ length: 501 }, () => ({ package_id: P1, price: 1 })) }).ok).toBe(false))
})

describe("isUuid", () => {
  it("accepts hyphenated uuids and rejects others", () => {
    expect(isUuid(P1)).toBe(true)
    expect(isUuid("u1")).toBe(false)
    expect(isUuid("11111111111111111111111111111111")).toBe(false)
  })
})
