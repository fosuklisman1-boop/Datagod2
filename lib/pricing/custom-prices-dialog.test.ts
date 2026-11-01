import { describe, it, expect } from "vitest"
import { parsePriceInput, computeChanges, warningFor, bulkPreview, type CustomPriceRow } from "./custom-prices-dialog"

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
  it("warns above role price", () => expect(warningFor(r, "7")).toMatch(/they pay more than normal/))
  it("ignores null dealer price", () => expect(warningFor(row("a", { dealer_price: null }), "1")).toBeNull())
})

describe("bulkPreview", () => {
  const rows = [
    row("m1", { size: "1", role_price: 6, dealer_price: 5 }),
    row("m2", { size: "2", role_price: 11, dealer_price: 0 }),
    row("t5", { network: "Telecel", size: "5", role_price: 25, dealer_price: 24 }),
  ]

  it("returns null until the value is usable", () => {
    expect(bulkPreview(rows, {}, { mode: "per_gb", value: "", base: "role", network: "MTN" })).toBeNull()
    expect(bulkPreview(rows, {}, { mode: "per_gb", value: "-2", base: "role", network: "MTN" })).toBeNull()
    expect(bulkPreview(rows, {}, { mode: "percent", value: "abc", base: "role", network: "MTN" })).toBeNull()
    expect(bulkPreview(rows, {}, { mode: "percent", value: "-100", base: "role", network: "MTN" })).toBeNull()
  })

  it("per-GB rate sets size x rate for one network", () => {
    const out = bulkPreview(rows, {}, { mode: "per_gb", value: "4.5", base: "role", network: "MTN" })!
    expect(out.map((p) => [p.row.id, p.newPrice])).toEqual([["m1", 4.5], ["m2", 9]])
  })

  it("signed percent adjusts the chosen base, across all networks", () => {
    const down = bulkPreview(rows, {}, { mode: "percent", value: "-10", base: "role", network: "all" })!
    expect(down.map((p) => [p.row.id, p.newPrice])).toEqual([["m1", 5.4], ["m2", 9.9], ["t5", 22.5]])
    const up = bulkPreview(rows, {}, { mode: "percent", value: "+5", base: "role", network: "Telecel" })!
    expect(up.map((p) => p.newPrice)).toEqual([26.25])
  })

  it("dealer base skips packages with no dealer price; custom base skips packages with no custom price", () => {
    const dealer = bulkPreview(rows, {}, { mode: "percent", value: "10", base: "dealer", network: "MTN" })!
    expect(dealer.map((p) => [p.row.id, p.newPrice, p.reason])).toEqual([["m1", 5.5, undefined], ["m2", null, "No dealer price"]])

    const custom = bulkPreview(rows, { m1: "5.00", m2: "" }, { mode: "percent", value: "-20", base: "custom", network: "MTN" })!
    expect(custom.map((p) => [p.row.id, p.newPrice, p.reason])).toEqual([["m1", 4, undefined], ["m2", null, "No custom price"]])
  })

  it("reports the current input, flags out-of-range results and carries the row warning", () => {
    const out = bulkPreview(rows, { m1: "5.50" }, { mode: "per_gb", value: "6000", base: "role", network: "MTN" })!
    expect(out[0]).toMatchObject({ current: 5.5, newPrice: 6000 })
    expect(out[0].reason).toBeUndefined()
    expect(out[0].warn).toMatch(/Above/)
    expect(out[1]).toMatchObject({ newPrice: null, reason: "Out of range" })
  })
})
