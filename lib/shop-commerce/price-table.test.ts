import { describe, it, expect } from "vitest"
import { bundleLabel, buildShopItemListJsonLd, buildShopPriceTable, formatShopPrice } from "./price-table"

const pkg = (id: string, network: string, size: string, selling_price: number, extra: Record<string, unknown> = {}) => ({
  id,
  is_available: true,
  selling_price,
  packages: { network, size, description: null },
  ...extra,
})

describe("bundleLabel", () => {
  it("appends GB to a bare size, as the storefront does", () => {
    expect(bundleLabel("2")).toBe("2GB")
    expect(bundleLabel(1.5)).toBe("1.5GB")
  })
  it("keeps sizes that already carry a unit", () => {
    expect(bundleLabel("500MB")).toBe("500MB")
  })
  it("is empty for a missing size", () => {
    expect(bundleLabel(null)).toBe("")
  })
})

describe("buildShopPriceTable", () => {
  it("groups by network in first-seen order and sorts each by size", () => {
    const t = buildShopPriceTable(
      [pkg("a", "MTN", "10", 40), pkg("b", "Telecel", "5", 22), pkg("c", "MTN", "1", 5.5), pkg("d", "MTN", "500MB", 3)],
      new Set(["a", "b", "c", "d"]),
    )
    expect(t.networks.map((n) => n.network)).toEqual(["MTN", "Telecel"])
    expect(t.networks[0].rows.map((r) => r.label)).toEqual(["500MB", "1GB", "10GB"])
    expect(t.networks[0].rows.map((r) => r.price)).toEqual([3, 5.5, 40])
    expect(t.priced).toBe(true)
  })

  it("prices only rows whose price is known to match checkout", () => {
    const t = buildShopPriceTable([pkg("a", "MTN", "1", 5), pkg("b", "MTN", "2", 9)], new Set(["a"]))
    expect(t.networks[0].rows.map((r) => r.price)).toEqual([5, null])
  })

  it("is unpriced when no row can be guaranteed to match checkout", () => {
    const t = buildShopPriceTable([pkg("a", "MTN", "1", 5)], new Set())
    expect(t.priced).toBe(false)
    expect(t.networks[0].rows[0]).toMatchObject({ label: "1GB", price: null })
  })

  it("drops unavailable rows and rows without a network or size", () => {
    const t = buildShopPriceTable(
      [pkg("a", "MTN", "1", 5, { is_available: false }), pkg("b", "", "1", 5), pkg("c", "MTN", "", 5), pkg("d", "MTN", "2", 9)],
      new Set(["a", "b", "c", "d"]),
    )
    expect(t.networks).toHaveLength(1)
    expect(t.networks[0].rows.map((r) => r.id)).toEqual(["d"])
  })

  it("never shows a non-numeric or zero selling price", () => {
    const t = buildShopPriceTable([pkg("a", "MTN", "1", Number.NaN), pkg("b", "MTN", "2", 0)], new Set(["a", "b"]))
    expect(t.networks[0].rows.map((r) => r.price)).toEqual([null, null])
  })

  it("keeps the selling price unrounded so it formats exactly like the client", () => {
    const t = buildShopPriceTable([pkg("a", "MTN", "1", 4.1 + 0.2)], new Set(["a"]))
    expect(formatShopPrice(t.networks[0].rows[0].price!)).toBe(`GH₵${(4.1 + 0.2).toFixed(2)}`)
  })
})

describe("buildShopItemListJsonLd", () => {
  const table = buildShopPriceTable([pkg("a", "MTN", "1", 5), pkg("b", "MTN", "2", 9)], new Set(["a"]))

  it("lists priced rows as Products with GHS offers on the shop URL", () => {
    const ld = buildShopItemListJsonLd({ shopName: "Kofi Data", url: "https://kofi.datagod.store", table, orderingEnabled: true }) as any
    expect(ld["@type"]).toBe("ItemList")
    expect(ld.itemListElement).toHaveLength(1)
    const item = ld.itemListElement[0]
    expect(item.position).toBe(1)
    expect(item.item.name).toBe("1GB MTN Data Bundle")
    expect(item.item.offers).toMatchObject({
      price: "5.00",
      priceCurrency: "GHS",
      availability: "https://schema.org/InStock",
      url: "https://kofi.datagod.store",
    })
  })

  it("marks offers out of stock while ordering is paused", () => {
    const ld = buildShopItemListJsonLd({ shopName: "K", url: "https://k.datagod.store", table, orderingEnabled: false }) as any
    expect(ld.itemListElement[0].item.offers.availability).toBe("https://schema.org/OutOfStock")
  })

  it("is null when nothing is priced", () => {
    const unpriced = buildShopPriceTable([pkg("a", "MTN", "1", 5)], new Set())
    expect(buildShopItemListJsonLd({ shopName: "K", url: "https://k.datagod.store", table: unpriced, orderingEnabled: true })).toBeNull()
  })
})
