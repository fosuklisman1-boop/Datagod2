import { describe, it, expect } from "vitest"
import { basePrice, fetchShopBundles } from "./pricing"

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
