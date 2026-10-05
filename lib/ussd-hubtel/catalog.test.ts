import { describe, it, expect } from "vitest"
import { decideTier, priceForTier } from "./catalog"

describe("decideTier", () => {
  it("falls back to the global default for unknown callers", () => {
    expect(decideTier("regular", undefined, null)).toEqual({ tier: "regular" })
    expect(decideTier("dealer", undefined, null)).toEqual({ tier: "dealer" })
  })
  it("dealers get dealer pricing", () => {
    expect(decideTier("regular", "dealer", null)).toEqual({ tier: "dealer" })
  })
  it("sub_agents with a parent shop get sub_agent; without one get regular", () => {
    expect(decideTier("regular", "sub_agent", "shop-1")).toEqual({ tier: "sub_agent", parentShopId: "shop-1" })
    expect(decideTier("regular", "sub_agent", null)).toEqual({ tier: "regular" })
  })
  it("any other registered user is regular", () => {
    expect(decideTier("dealer", "user", null)).toEqual({ tier: "regular" })
  })
})

describe("priceForTier", () => {
  const pkg = { price: 10, dealer_price: 8 }
  it("regular uses price", () => expect(priceForTier(pkg, "regular")).toEqual({ price: 10, parentProfit: null }))
  it("dealer uses dealer_price when set and > 0", () => {
    expect(priceForTier(pkg, "dealer").price).toBe(8)
    expect(priceForTier({ price: 10, dealer_price: 0 }, "dealer").price).toBe(10)
    expect(priceForTier({ price: 10, dealer_price: null }, "dealer").price).toBe(10)
  })
  it("sub_agent uses the catalog parent_price and wholesale_margin", () => {
    expect(priceForTier(pkg, "sub_agent", { parent_price: "9", wholesale_margin: "1.5" })).toEqual({ price: 9, parentProfit: 1.5 })
  })
  it("sub_agent without a catalog row falls back to package price", () => {
    expect(priceForTier(pkg, "sub_agent", null)).toEqual({ price: 10, parentProfit: null })
  })
})
