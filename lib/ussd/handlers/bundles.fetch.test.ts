// Characterisation of fetchBundles (the USSD bundle menu's price list) and the new non-paged fetchAllBundles that
// shares its body. fetchBundles output was captured before the refactor and must not change.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeFakeCatalogue } from "@/lib/text-to-buy/fake-catalogue.test-helper"

const h = vi.hoisted(() => ({ client: null as any, subAgent: vi.fn() }))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => h.client.from(t) }) }))
vi.mock("next/server", () => ({ after: vi.fn() }))
vi.mock("@/lib/shop-commerce/pricing", async (orig) => ({ ...(await orig<object>()), subAgentBundles: h.subAgent }))

import { fetchBundles, fetchAllBundles } from "./bundles"

const pkg = (id: string, network: string, size: string, price: number, dealer: number | null, avail = true) =>
  ({ id, network, size, price, dealer_price: dealer, is_available: avail })

const PACKAGES = [
  pkg("m3", "MTN", "3", 30, 25),
  pkg("m1", "MTN", "1", 10, 8),
  pkg("m2", "MTN", "2", 20, null),
  pkg("m9", "MTN", "9", 1, 1, false), // unavailable: never listed
  pkg("m4", "MTN", "4", 40, 35),
  pkg("m5", "MTN", "5", 50, 45),
  pkg("m6", "MTN", "6", 60, 55),
  pkg("t1", "Telecel", "1", 11, 9),
]

function seed(extra: Record<string, any[]> = {}) {
  const f = makeFakeCatalogue({
    packages: PACKAGES,
    users: [{ id: "u1", pricing_mode: "custom" }, { id: "u2", pricing_mode: null }],
    user_package_prices: [{ user_id: "u1", package_id: "m1", price: 6 }],
    ...extra,
  })
  h.client = f.client
  return f
}

beforeEach(() => { h.subAgent.mockReset(); seed() })

describe("fetchBundles (unchanged behaviour)", () => {
  it("regular tier: available packages of one network, cheapest first, first page of 5, exact total", async () => {
    const r = await fetchBundles("MTN", 0, "regular")
    expect(r.bundles).toEqual([
      { id: "m1", size: "1", price: 10 }, { id: "m2", size: "2", price: 20 }, { id: "m3", size: "3", price: 30 },
      { id: "m4", size: "4", price: 40 }, { id: "m5", size: "5", price: 50 },
    ])
    expect(r.total).toBe(6)
  })

  it("second page holds the remainder", async () => {
    const r = await fetchBundles("MTN", 1, "regular")
    expect(r.bundles).toEqual([{ id: "m6", size: "6", price: 60 }])
    expect(r.total).toBe(6)
  })

  it("dealer tier uses dealer_price when it is above zero, else price", async () => {
    // ordering is by list price; the dealer price is what is shown
    const r = await fetchBundles("MTN", 0, "dealer")
    expect(r.bundles.map((b) => [b.id, b.price])).toEqual([["m1", 8], ["m2", 20], ["m3", 25], ["m4", 35], ["m5", 45]])
  })

  it("a custom-price user sees the custom price", async () => {
    const r = await fetchBundles("MTN", 0, "regular", undefined, "u1")
    expect(r.bundles.find((b) => b.id === "m1")!.price).toBe(6)
  })

  it("an unreadable custom-price table falls back to role prices on the menu", async () => {
    const f = seed()
    f.db.failOn["user_package_prices"] = { message: "boom" }
    const r = await fetchBundles("MTN", 0, "regular", undefined, "u1")
    expect(r.bundles.find((b) => b.id === "m1")!.price).toBe(10)
  })

  it("filters by network", async () => {
    const r = await fetchBundles("Telecel", 0, "regular")
    expect(r.bundles).toEqual([{ id: "t1", size: "1", price: 11 }])
  })

  it("sub_agent tier pages the parent's live-priced list; a failed read lists nothing", async () => {
    const list = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, size: String(i + 1), price: i + 1 }))
    h.subAgent.mockResolvedValue(list)
    const r = await fetchBundles("MTN", 1, "sub_agent", "shop-1", "u2")
    expect(h.subAgent).toHaveBeenCalledWith("shop-1", "MTN", expect.anything())
    expect(r).toEqual({ bundles: list.slice(5), total: 7 })
    h.subAgent.mockRejectedValue(new Error("x"))
    expect(await fetchBundles("MTN", 0, "sub_agent", "shop-1")).toEqual({ bundles: [], total: 0 })
  })
})

describe("fetchAllBundles", () => {
  it("returns every available package of the network at the same prices fetchBundles shows", async () => {
    const all = await fetchAllBundles("MTN", "dealer")
    expect(all.map((b) => b.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"])
    const paged = [...(await fetchBundles("MTN", 0, "dealer")).bundles, ...(await fetchBundles("MTN", 1, "dealer")).bundles]
    expect(all).toEqual(paged)
  })

  it("applies custom prices", async () => {
    expect((await fetchAllBundles("MTN", "regular", undefined, "u1")).find((b) => b.id === "m1")!.price).toBe(6)
  })

  it("sub_agent tier uses the parent's live list", async () => {
    h.subAgent.mockResolvedValue([{ id: "s1", size: "1", price: 12.5 }])
    expect(await fetchAllBundles("MTN", "sub_agent", "shop-1", "u2")).toEqual([{ id: "s1", size: "1", price: 12.5 }])
  })

  it("fails closed: an unreadable custom price or sub-agent catalog throws instead of showing a role price", async () => {
    const f = seed()
    f.db.failOn["user_package_prices"] = { message: "boom" }
    await expect(fetchAllBundles("MTN", "regular", undefined, "u1")).rejects.toThrow()
    h.subAgent.mockRejectedValue(new Error("x"))
    await expect(fetchAllBundles("MTN", "sub_agent", "shop-1")).rejects.toThrow()
  })

  it("fails closed when the packages read fails", async () => {
    const f = seed()
    f.db.failOn["packages"] = { message: "boom" }
    await expect(fetchAllBundles("MTN", "regular")).rejects.toThrow()
  })
})
