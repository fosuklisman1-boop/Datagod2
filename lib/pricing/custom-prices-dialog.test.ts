import { describe, it, expect } from "vitest"
import { parsePriceInput, computeChanges, warningFor, type CustomPriceRow } from "./custom-prices-dialog"

const row = (id: string, o: Partial<CustomPriceRow> = {}): CustomPriceRow => ({
  id, network: "MTN", size: "1", price: 6, dealer_price: 5, role_price: 6, custom_price: null, ...o,
})

describe("parsePriceInput", () => {
  it("blank is null", () => expect(parsePriceInput("  ")).toEqual({ ok: true, value: null }))
  it("accepts decimals", () => {
    expect(parsePriceInput("6.5")).toEqual({ ok: true, value: 6.5 })
    expect(parsePriceInput(".5")).toEqual({ ok: true, value: 0.5 })
  })
  it.each(["abc", "1e2", "-1", "0", "1,5", "1.234", "10001", "1.2.3"])("rejects %s", (s) => expect(parsePriceInput(s).ok).toBe(false))
})

describe("computeChanges", () => {
  it("treats 6 and 6.00 as equal to a saved 6", () => {
    const rows = [row("a", { custom_price: 6 }), row("b", { custom_price: 6 })]
    expect(computeChanges(rows, { a: "6", b: "6.00" }).changes).toEqual([])
  })
  it("sets, changes and removes", () => {
    const rows = [row("a"), row("b", { custom_price: 6 }), row("c", { custom_price: 6 }), row("d")]
    const { changes } = computeChanges(rows, { a: "5.5", b: "", c: "7", d: "" })
    expect(changes).toEqual([{ package_id: "a", price: 5.5 }, { package_id: "b", price: null }, { package_id: "c", price: 7 }])
  })
  it("reports invalid input and does not send it", () => {
    const { changes, invalid } = computeChanges([row("a"), row("b")], { a: "x", b: "4" })
    expect(changes).toEqual([{ package_id: "b", price: 4 }])
    expect(Object.keys(invalid)).toEqual(["a"])
  })
})

describe("warningFor", () => {
  const r = row("a", { dealer_price: 5, role_price: 6 })
  it("no warning for blank, invalid or in-range", () => {
    expect(warningFor(r, "")).toBeNull()
    expect(warningFor(r, "x")).toBeNull()
    expect(warningFor(r, "5.5")).toBeNull()
  })
  it("warns below dealer", () => expect(warningFor(r, "4")).toMatch(/Below the dealer/))
  it("warns above role price", () => expect(warningFor(r, "7")).toMatch(/Above/))
  it("ignores null dealer price", () => expect(warningFor(row("a", { dealer_price: null }), "1")).toBeNull())
})
