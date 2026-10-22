import { describe, it, expect, vi, beforeEach } from "vitest"

let row: Record<string, unknown> | null = null

vi.mock("./supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        or: () => ({
          eq: () => ({ single: async () => ({ data: row, error: row ? null : { code: "PGRST116" } }) }),
        }),
      }),
    }),
    rpc: async () => ({ data: null, error: null }),
  },
}))
vi.mock("./price-adjustment-service", () => ({
  getPriceAdjustments: vi.fn(),
  getAdjustmentForNetwork: vi.fn(),
  applyPriceAdjustment: vi.fn(),
}))
vi.mock("./withdrawal-policy", () => ({ checkWithdrawalCoolingOff: vi.fn() }))

import { shopService } from "./shop-service"

const baseShop = { shop_name: "Kofi Data", shop_slug: "kofi", subdomain: "kofi", is_active: true, is_blocked: false }
const bigDataUri = `data:image/jpeg;base64,${"A".repeat(2_000_000)}`

describe("shopService.getShopBySlug - logo", () => {
  beforeEach(() => {
    row = null
  })

  it("replaces an embedded data-URI logo with a short absolute route URL so pages stay small", async () => {
    row = { ...baseShop, logo_url: bigDataUri }
    const shop = await shopService.getShopBySlug("kofi")
    expect(shop?.logo_url?.startsWith("https://www.datagod.store/api/shop-logo/kofi?v=")).toBe(true)
    expect(shop!.logo_url!.length).toBeLessThan(120)
    expect(JSON.stringify(shop).length).toBeLessThan(5_000)
  })

  it("leaves a normal URL logo untouched", async () => {
    row = { ...baseShop, logo_url: "https://cdn.example.com/kofi.png" }
    expect((await shopService.getShopBySlug("kofi"))?.logo_url).toBe("https://cdn.example.com/kofi.png")
  })

  it("keeps a missing logo as null", async () => {
    row = { ...baseShop, logo_url: null }
    expect((await shopService.getShopBySlug("kofi"))?.logo_url).toBeNull()
  })

  it("still returns null for an unknown shop", async () => {
    row = null
    expect(await shopService.getShopBySlug("ghost")).toBeNull()
  })
})
