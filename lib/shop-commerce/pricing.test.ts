import { describe, it, expect } from "vitest"
import { basePrice, fetchShopBundles, sizeToMb, verifyBundlePrice } from "./pricing"

describe("basePrice", () => {
  it("uses dealer_price for dealers when set", () => {
    expect(basePrice({ price: 10, dealer_price: 8 }, true)).toBe(8)
  })
  it("uses price for dealers when dealer_price is 0/absent", () => {
    expect(basePrice({ price: 10, dealer_price: 0 }, true)).toBe(10)
    expect(basePrice({ price: 10 }, true)).toBe(10)
  })
  it("uses price for non-dealers regardless of dealer_price", () => {
    expect(basePrice({ price: 10, dealer_price: 8 }, false)).toBe(10)
  })
})

describe("sizeToMb", () => {
  it("parses MB values, case-insensitively", () => {
    expect(sizeToMb("500MB")).toBe(500)
    expect(sizeToMb("500mb")).toBe(500)
  })
  it("converts GB values to MB, case-insensitively", () => {
    expect(sizeToMb("2GB")).toBe(2048)
    expect(sizeToMb("2gb")).toBe(2048)
  })
  it("converts TB values to MB", () => {
    expect(sizeToMb("1TB")).toBe(1024 * 1024)
  })
  it("handles decimal sizes", () => {
    expect(sizeToMb("1.5GB")).toBe(1536)
  })
  it("treats a bare number (no unit) as GB", () => {
    expect(sizeToMb("3")).toBe(3 * 1024)
  })
  it("returns 0 for an unparseable, unit-less string", () => {
    expect(sizeToMb("not a number")).toBe(0)
  })
})

// Fake Supabase client injected directly into fetchShopBundles (no @supabase/supabase-js
// mocking needed — the function accepts an optional client param for exactly this reason).
// Each table's canned response lives in `tables`; the chain object is a thenable that also
// exposes .single()/.maybeSingle() as terminal methods, mirroring the real query builder.
function makeChain(result: { data: unknown; error?: unknown }) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    single: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  }
  return chain
}

function fakeClient(tables: Record<string, { data: unknown; error?: unknown }>) {
  return {
    from: (table: string) => makeChain(tables[table] ?? { data: null, error: null }),
  } as any
}

describe("fetchShopBundles", () => {
  it("regular shop: prices with dealer basePrice + profit_margin, sorted by size ascending", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer" } },
      shop_packages: {
        data: [
          { package_id: "p1", profit_margin: 2 },
          { package_id: "p2", profit_margin: 3 },
        ],
      },
      packages: {
        data: [
          { id: "p1", size: "2GB", price: 10, dealer_price: 8 },
          { id: "p2", size: "1GB", price: 5, dealer_price: 4 },
        ],
      },
    })

    const result = await fetchShopBundles("s1", "MTN", undefined, client)

    expect(result).toEqual([
      { id: "p2", size: "1GB", price: 7 },  // dealer_price 4 + margin 3
      { id: "p1", size: "2GB", price: 10 }, // dealer_price 8 + margin 2
    ])
  })

  it("regular shop: returns [] when the shop has no available packages", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer" } },
      shop_packages: { data: [] },
    })

    const result = await fetchShopBundles("s1", "MTN", undefined, client)
    expect(result).toEqual([])
  })

  it("sub-agent (new model): prices from parent_price + sub_agent_profit_margin, ignoring dealer status", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "agent" } }, // parent not a dealer — shouldn't matter for the new model
      sub_agent_shop_packages: {
        data: [
          { package_id: "p1", parent_price: 10, sub_agent_profit_margin: 2 },
          { package_id: "p2", parent_price: 5, sub_agent_profit_margin: 1 },
        ],
      },
      packages: {
        data: [
          { id: "p1", size: "2GB" },
          { id: "p2", size: "1GB" },
        ],
      },
    })

    const result = await fetchShopBundles("sub1", "MTN", "parent1", client)

    expect(result).toEqual([
      { id: "p2", size: "1GB", price: 6 },  // 5 + 1
      { id: "p1", size: "2GB", price: 12 }, // 10 + 2
    ])
  })

  it("sub-agent (old model fallback): prices from basePrice + wholesale_margin + sub_agent_profit_margin", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer" } },
      sub_agent_shop_packages: { data: [] }, // nothing in the new model → falls back
      sub_agent_catalog: {
        data: [{ package_id: "p1", wholesale_margin: 1, sub_agent_profit_margin: 2 }],
      },
      packages: {
        data: [{ id: "p1", size: "1GB", price: 10, dealer_price: 8 }],
      },
    })

    const result = await fetchShopBundles("sub1", "MTN", "parent1", client)

    expect(result).toEqual([
      { id: "p1", size: "1GB", price: 11 }, // dealer_price 8 + wholesale_margin 1 + sub_agent_profit_margin 2
    ])
  })
})

// The confirm-time re-verification path — this is the anti stale-session-price-
// manipulation guard, so it gets its own coverage independent of fetchShopBundles.
describe("verifyBundlePrice", () => {
  it("regular shop: valid package → verifiedPrice from dealer basePrice + profit_margin", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer" } },
      shop_packages: {
        data: { profit_margin: 2, packages: { price: 10, dealer_price: 8, active: true } },
      },
    })

    const result = await verifyBundlePrice("s1", "p1", undefined, client)

    expect(result).toEqual({ verifiedPrice: 10, profitAmount: 2, parentProfitAmount: 0 }) // 8 + 2
  })

  it("regular shop: package deactivated → null", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer" } },
      shop_packages: {
        data: { profit_margin: 2, packages: { price: 10, dealer_price: 8, active: false } },
      },
    })

    const result = await verifyBundlePrice("s1", "p1", undefined, client)
    expect(result).toBeNull()
  })

  it("sub-agent (new model): valid package → verifiedPrice from parent_price + sub_agent_profit_margin", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "pu1" } },
      users: { data: { role: "dealer" } }, // parentIsDealer = true
      sub_agent_shop_packages: {
        data: { parent_price: 12, sub_agent_profit_margin: 3, packages: { price: 10, dealer_price: 8, active: true } },
      },
    })

    const result = await verifyBundlePrice("sub1", "p1", "parent1", client)

    // bp = basePrice({price:10, dealer_price:8}, dealer) = 8; parentProfitAmount = max(0, 12 - 8) = 4
    expect(result).toEqual({ verifiedPrice: 15, profitAmount: 3, parentProfitAmount: 4 })
  })

  it("sub-agent (old model fallback): valid package → verifiedPrice from basePrice + wholesale_margin + sub_agent_profit_margin", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "pu1" } },
      users: { data: { role: "dealer" } },
      sub_agent_shop_packages: { data: null }, // no row in the new model → falls back
      sub_agent_catalog: {
        data: { wholesale_margin: 1, sub_agent_profit_margin: 2, packages: { price: 10, dealer_price: 8, active: true } },
      },
    })

    const result = await verifyBundlePrice("sub1", "p1", "parent1", client)

    expect(result).toEqual({ verifiedPrice: 11, profitAmount: 2, parentProfitAmount: 1 }) // 8 + 1 + 2
  })

  it("sub-agent: package deactivated in both new-model row absent and catalog fallback → null", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "pu1" } },
      users: { data: { role: "dealer" } },
      sub_agent_shop_packages: { data: null }, // no row in the new model → falls back
      sub_agent_catalog: {
        data: { wholesale_margin: 1, sub_agent_profit_margin: 2, packages: { price: 10, dealer_price: 8, active: false } },
      },
    })

    const result = await verifyBundlePrice("sub1", "p1", "parent1", client)
    expect(result).toBeNull()
  })
})
