// lib/products-catalog.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    packagesRows: [
      { id: "p1", network: "MTN", size: "1", price: 6.5, dealer_price: 5.8, is_available: true },
      { id: "p5", network: "MTN", size: "5", price: 27, dealer_price: 24.5, is_available: true },
      { id: "p2", network: "AT - iShare", size: "2", price: 12, dealer_price: 10.5, is_available: true },
    ],
    afaPriceRow: { price: "50.00" } as { price: string } | null,
    pricingMode: "role" as string,
    customRows: [] as { package_id: string; price: number }[],
    usersFail: false,
    rolesFail: false,
    rolePrices: [] as { role_id: string; package_id: string; price: number }[],
  }
  const ROLES = [
    { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
    { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
    { id: "r-sub", slug: "sub_agent", rank: null, is_system: true, archived_at: null },
    { id: "r-admin", slug: "admin", rank: null, is_system: true, archived_at: null },
  ]
  const fake = {
    from: (table: string) => {
      if (table === "packages") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: state.packagesRows, error: null }),
          }),
        }
      }
      if (table === "afa_registration_prices") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: state.afaPriceRow, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === "users") {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(state.usersFail ? { data: null, error: { message: "boom" } } : { data: { pricing_mode: state.pricingMode }, error: null }) }) }) }
      }
      if (table === "user_package_prices") {
        // the resolver reads .select().eq().limit()
        return { select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: state.customRows, error: null }) }) }) }
      }
      if (table === "roles" || table === "role_package_prices") {
        const rows = () => (table === "roles" ? ROLES : state.rolePrices)
        const c: any = {
          select: () => c, eq: () => c, in: () => c, is: () => c, order: () => c, limit: () => c,
          then: (r: any, j: any) =>
            Promise.resolve(state.rolesFail ? { data: null, error: { message: "boom" } } : { data: rows(), error: null }).then(r, j),
        }
        return c
      }
      throw new Error(`Unexpected table in fake client: ${table}`)
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

vi.mock("@/lib/airtime-pricing", () => ({
  isAirtimeEnabled: vi.fn(async (network: string) => network !== "Telecel"),
  getAirtimeLimits: vi.fn(async () => ({ min: 1, max: 500 })),
  airtimeBaseFeeRate: vi.fn(async (_network: string, isDealer: boolean) => (isDealer ? 3 : 5)),
}))

vi.mock("@/lib/results-checker-service", () => ({
  isExamBoardEnabled: vi.fn(async (board: string) => board !== "NOVDEC"),
  calculateRCPrice: vi.fn(async () => ({
    basePrice: 15, markupPerVoucher: 0, unitPrice: 15, totalPaid: 15,
    merchantCommission: 0, bulkApplied: false,
  })),
}))

import { buildProductsCatalog } from "./products-catalog"

beforeEach(() => {
  h.state.packagesRows = [
    { id: "p1", network: "MTN", size: "1", price: 6.5, dealer_price: 5.8, is_available: true },
    { id: "p5", network: "MTN", size: "5", price: 27, dealer_price: 24.5, is_available: true },
    { id: "p2", network: "AT - iShare", size: "2", price: 12, dealer_price: 10.5, is_available: true },
  ]
  h.state.afaPriceRow = { price: "50.00" }
  h.state.pricingMode = "role"
  h.state.customRows = []
  h.state.usersFail = false
  h.state.rolesFail = false
  // What migration 0184 seeds from packages.dealer_price: the dealer ladder lives in role_package_prices.
  h.state.rolePrices = [
    { role_id: "r-dealer", package_id: "p1", price: 5.8 },
    { role_id: "r-dealer", package_id: "p5", price: 24.5 },
    { role_id: "r-dealer", package_id: "p2", price: 10.5 },
  ]
})

describe("buildProductsCatalog", () => {
  it("data bundles use the user's custom price in custom mode", async () => {
    h.state.pricingMode = "custom"
    h.state.customRows = [{ package_id: "p1", price: 4.25 }]
    const res = await buildProductsCatalog("dealer", "u1")
    expect(res.data_bundles.find((b) => b.network === "MTN" && b.size_gb === "1")!.price).toBe(4.25)
    expect(res.data_bundles.find((b) => b.network === "MTN" && b.size_gb === "5")!.price).toBe(24.5)
  })

  it("custom prices are ignored in role mode", async () => {
    h.state.customRows = [{ package_id: "p1", price: 4.25 }]
    const res = await buildProductsCatalog("dealer", "u1")
    expect(res.data_bundles.find((b) => b.network === "MTN" && b.size_gb === "1")!.price).toBe(5.8)
  })

  it("falls back to role prices when the users read fails", async () => {
    h.state.usersFail = true
    h.state.customRows = [{ package_id: "p1", price: 4.25 }]
    const res = await buildProductsCatalog("dealer", "u1")
    expect(res.data_bundles.find((b) => b.network === "MTN" && b.size_gb === "1")!.price).toBe(5.8)
  })

  it("prices data bundles at customer price for a non-dealer role", async () => {
    const catalog = await buildProductsCatalog("user")
    const mtn1gb = catalog.data_bundles.find((b) => b.network === "MTN" && b.size_gb === "1")
    expect(mtn1gb?.price).toBe(6.5)
  })

  it("prices data bundles at dealer price for a dealer role", async () => {
    const catalog = await buildProductsCatalog("dealer")
    const mtn1gb = catalog.data_bundles.find((b) => b.network === "MTN" && b.size_gb === "1")
    expect(mtn1gb?.price).toBe(5.8)
  })

  const price1gb = (c: Awaited<ReturnType<typeof buildProductsCatalog>>) =>
    c.data_bundles.find((b) => b.network === "MTN" && b.size_gb === "1")!.price

  it("a role price row for the user role shows as that price", async () => {
    h.state.rolePrices = [{ role_id: "r-user", package_id: "p1", price: 5.5 }]
    expect(price1gb(await buildProductsCatalog("user"))).toBe(5.5)
  })

  it("a dealer role price row is shown to a dealer", async () => {
    h.state.rolePrices = [{ role_id: "r-dealer", package_id: "p1", price: 5.1 }]
    expect(price1gb(await buildProductsCatalog("dealer"))).toBe(5.1)
  })

  it("an admin is shown the user ladder (as a normal user)", async () => {
    h.state.rolePrices = [{ role_id: "r-dealer", package_id: "p1", price: 5.1 }, { role_id: "r-user", package_id: "p1", price: 6 }]
    expect(price1gb(await buildProductsCatalog("admin"))).toBe(6)
  })

  it("shows public prices when the roles read fails", async () => {
    h.state.rolesFail = true
    expect(price1gb(await buildProductsCatalog("dealer"))).toBe(6.5)
  })

  it("excludes a disabled airtime network", async () => {
    const catalog = await buildProductsCatalog("user")
    expect(catalog.airtime.find((a) => a.network === "Telecel")).toBeUndefined()
    expect(catalog.airtime.find((a) => a.network === "MTN")).toBeDefined()
  })

  it("excludes a disabled results-checker board", async () => {
    const catalog = await buildProductsCatalog("user")
    expect(catalog.results_checker.find((b) => b.exam_board === "NOVDEC")).toBeUndefined()
    expect(catalog.results_checker.find((b) => b.exam_board === "WASSCE")).toBeDefined()
  })

  it("reports afa as enabled with the active price", async () => {
    const catalog = await buildProductsCatalog("user")
    expect(catalog.afa).toEqual({ enabled: true, price: 50 })
  })

  it("reports afa as disabled when no active price row exists", async () => {
    h.state.afaPriceRow = null
    const catalog = await buildProductsCatalog("user")
    expect(catalog.afa).toEqual({ enabled: false, price: null })
  })
})
