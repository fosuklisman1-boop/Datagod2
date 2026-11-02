import { describe, it, expect } from "vitest"
import { buildComparison } from "./compare"
import { buildPriceGroups } from "./data-prices"
import type { PriceGroups, PriceRow } from "./data-prices"

const row = (size: string, price: number, gb: number | null): PriceRow => ({
  size,
  label: size,
  price,
  gb,
  perGb: gb ? Math.round((price / gb) * 100) / 100 : null,
})

const empty: PriceGroups = { MTN: [], Telecel: [], AT: [] }

describe("buildComparison", () => {
  it("picks the lowest per-GB across a network's groups", () => {
    const prices: PriceGroups = {
      ...empty,
      AT: [
        { network: "AT - iShare", rows: [row("1GB", 5, 1), row("5GB", 20, 5)] },
        { network: "AT - BigTime", rows: [row("10GB", 30, 10)] },
      ],
    }
    const c = buildComparison(prices)
    expect(c.best).toEqual([{ network: "AT", perGb: 3, size: "10GB", label: "10GB", price: 30 }])
  })

  it("breaks per-GB ties with the cheaper price", () => {
    const prices: PriceGroups = {
      ...empty,
      MTN: [{ network: "MTN", rows: [row("2GB", 10, 2), row("1GB", 5, 1)] }],
    }
    expect(buildComparison(prices).best[0]).toMatchObject({ network: "MTN", perGb: 5, size: "1GB", price: 5 })
  })

  it("omits networks without a per-GB value and sizes nobody sells", () => {
    const prices: PriceGroups = {
      MTN: [{ network: "MTN", rows: [row("1GB", 4, 1), row("2GB", 8, 2), row("5GB", 20, 5)] }],
      Telecel: [{ network: "Telecel", rows: [row("Weekly", 3, null)] }],
      AT: [],
    }
    const c = buildComparison(prices)
    expect(c.best.map((b) => b.network)).toEqual(["MTN"])
    expect(c.sizes.map((s) => s.gb)).toEqual([1, 2, 5])
  })

  it("uses null for a network lacking an exact size and the cheapest price when several rows match", () => {
    const prices: PriceGroups = {
      MTN: [{ network: "MTN", rows: [row("1GB", 4, 1), row("10GB", 40, 10)] }],
      Telecel: [{ network: "Telecel", rows: [row("1GB", 5, 1)] }],
      AT: [
        { network: "AT - iShare", rows: [row("1GB", 6, 1)] },
        { network: "AT - BigTime", rows: [row("1GB", 4.5, 1)] },
      ],
    }
    const c = buildComparison(prices)
    expect(c.sizes).toEqual([
      { gb: 1, cells: { MTN: 4, Telecel: 5, AT: 4.5 } },
      { gb: 10, cells: { MTN: 40, Telecel: null, AT: null } },
    ])
  })

  it("works on rows built from bare-number package sizes", () => {
    const adj = { price_adjustment_mtn: 0, price_adjustment_telecel: 0, price_adjustment_at_ishare: 0, price_adjustment_at_bigtime: 0 }
    const prices = buildPriceGroups(
      [
        { network: "MTN", size: "1", price: 5, is_available: true },
        { network: "MTN", size: "2", price: 9, is_available: true },
        { network: "Telecel", size: "1", price: 6, is_available: true },
      ],
      adj,
    )
    const c = buildComparison(prices)
    expect(c.best[0]).toEqual({ network: "MTN", perGb: 4.5, size: "2", label: "2GB", price: 9 })
    expect(c.sizes[0]).toEqual({ gb: 1, cells: { MTN: 5, Telecel: 6, AT: null } })
  })

  it("returns empty results when there are no prices", () => {
    expect(buildComparison(empty)).toEqual({ best: [], sizes: [] })
  })
})
