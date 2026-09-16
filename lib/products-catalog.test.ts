// lib/products-catalog.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    packagesRows: [
      { network: "MTN", size: "1", price: 6.5, dealer_price: 5.8, is_available: true },
      { network: "MTN", size: "5", price: 27, dealer_price: 24.5, is_available: true },
      { network: "AT - iShare", size: "2", price: 12, dealer_price: 10.5, is_available: true },
    ],
    afaPriceRow: { price: "50.00" } as { price: string } | null,
  }
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
    { network: "MTN", size: "1", price: 6.5, dealer_price: 5.8, is_available: true },
    { network: "MTN", size: "5", price: 27, dealer_price: 24.5, is_available: true },
    { network: "AT - iShare", size: "2", price: 12, dealer_price: 10.5, is_available: true },
  ]
  h.state.afaPriceRow = { price: "50.00" }
})

describe("buildProductsCatalog", () => {
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
