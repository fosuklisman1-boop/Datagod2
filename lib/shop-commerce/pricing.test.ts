import { describe, it, expect } from "vitest"
import { CustomPriceReadError } from "@/lib/pricing/package-price"
import { basePrice, catalogWholesaleMargin, subAgentBundles, subAgentCosts, directShopPricing, fetchShopBundles, marginsValid, parentProfitFromCatalog, sizeToMb, verifyBundlePrice } from "./pricing"

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
const first = (r: { data: unknown; error?: unknown }) =>
  Array.isArray(r.data) ? { ...r, data: r.data[0] ?? null } : r

function makeChain(result: { data: unknown; error?: unknown }) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => chain,
    // A list fixture serves both the helper's list read and a row read (its first row).
    single: () => Promise.resolve(first(result)),
    maybeSingle: () => Promise.resolve(first(result)),
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

  it("sub-agent (new model): live parent cost (role + active wholesale) + sub_agent_profit_margin; stale parent_price ignored", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer" } },
      sub_agent_shop_packages: {
        data: [
          { package_id: "p1", parent_price: 99, sub_agent_profit_margin: 2 },
          { package_id: "p2", parent_price: 1, sub_agent_profit_margin: 1 },
          { package_id: "p3", parent_price: 5, sub_agent_profit_margin: 1 }, // parent no longer offers p3
        ],
      },
      sub_agent_catalog: {
        data: [
          { package_id: "p1", wholesale_margin: 1, packages: { id: "p1", size: "2GB", network: "MTN", price: 10, dealer_price: 8, is_available: true } },
          { package_id: "p2", wholesale_margin: 0.5, packages: { id: "p2", size: "1GB", network: "MTN", price: 5, dealer_price: 4, is_available: true } },
        ],
      },
    })

    const result = await fetchShopBundles("sub1", "MTN", "parent1", client)

    expect(result).toEqual([
      { id: "p2", size: "1GB", price: 5.5 }, // dealer 4 + wholesale 0.5 + sub 1
      { id: "p1", size: "2GB", price: 11 },  // dealer 8 + wholesale 1 + sub 2
    ])
  })

  it("sub-agent (new model): a parent's read failure lists nothing", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer" } },
      sub_agent_shop_packages: { data: [{ package_id: "p1", parent_price: 9, sub_agent_profit_margin: 1 }] },
      sub_agent_catalog: { data: null, error: { message: "boom" } },
    })
    expect(await fetchShopBundles("sub1", "MTN", "parent1", client)).toEqual([])
  })

  it("sub-agent (old model fallback): prices from basePrice + wholesale_margin + sub_agent_profit_margin", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer" } },
      sub_agent_shop_packages: { data: [] }, // nothing in the new model → falls back
      sub_agent_catalog: {
        data: [{ package_id: "p1", wholesale_margin: 1, sub_agent_profit_margin: 2, packages: { id: "p1", size: "1GB", network: "MTN", price: 10, dealer_price: 8, is_available: true } }],
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
  it("regular shop with DUPLICATE shop_packages rows for the package: still verifies (latest row), not 'no longer available'", async () => {
    // Real PostgREST: .maybeSingle() over 2+ rows is an error with data null, unless the query is limited to 1.
    const calls: Array<[string, ...unknown[]]> = []
    const dupChain: any = {
      select: () => dupChain,
      eq: () => dupChain,
      order: (...a: unknown[]) => { calls.push(["order", ...a]); return dupChain },
      limit: (n: number) => { calls.push(["limit", n]); return dupChain },
      maybeSingle: () => Promise.resolve(
        calls.some(c => c[0] === "limit" && c[1] === 1)
          ? { data: { profit_margin: 3, packages: { price: 10, dealer_price: 8, is_available: true } }, error: null }
          : { data: null, error: { code: "PGRST116", message: "multiple rows" } }
      ),
    }
    const base = fakeClient({ user_shops: { data: { user_id: "u1" } }, users: { data: { role: "dealer" } } })
    const client = { from: (t: string) => (t === "shop_packages" ? dupChain : base.from(t)) } as any

    const result = await verifyBundlePrice("s1", "p1", undefined, client)

    expect(result).toEqual({ verifiedPrice: 11, profitAmount: 3, parentProfitAmount: 0 })
    expect(calls).toContainEqual(["order", "updated_at", { ascending: false }])
  })

  it("regular shop: valid package → verifiedPrice from dealer basePrice + profit_margin", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer" } },
      shop_packages: {
        data: { profit_margin: 2, packages: { price: 10, dealer_price: 8, is_available: true } },
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
        data: { profit_margin: 2, packages: { price: 10, dealer_price: 8, is_available: false } },
      },
    })

    const result = await verifyBundlePrice("s1", "p1", undefined, client)
    expect(result).toBeNull()
  })

  it("sub-agent (new model): verifiedPrice = live parent cost + sub_agent_profit_margin; parent credited the wholesale margin", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "pu1" } },
      users: { data: { role: "dealer" } }, // parentIsDealer = true
      sub_agent_shop_packages: {
        data: { parent_price: 9, sub_agent_profit_margin: 3, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } },
      },
      sub_agent_catalog: { data: [{ package_id: "p1", wholesale_margin: 2, packages: { id: "p1", size: "1GB", network: "MTN", price: 10, dealer_price: 8, is_available: true } }] },
    })

    const result = await verifyBundlePrice("sub1", "p1", "parent1", client)

    // stale snapshot 9 ignored: live dealer 8 + wholesale 2 = 10; + sub margin 3 = 13; parent credited 2
    expect(result).toEqual({ verifiedPrice: 13, profitAmount: 3, parentProfitAmount: 2 })
  })

  it("sub-agent (new model): the parent no longer offers the package (no active row) → null", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "pu1" } },
      users: { data: { role: "dealer" } },
      sub_agent_shop_packages: {
        data: { parent_price: 9, sub_agent_profit_margin: 3, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } },
      },
      sub_agent_catalog: { data: [] },
    })
    expect(await verifyBundlePrice("sub1", "p1", "parent1", client)).toBeNull()
  })

  it("sub-agent (new model): the parent's catalog cannot be read → null (refuse)", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "pu1" } },
      users: { data: { role: "dealer" } },
      sub_agent_shop_packages: {
        data: { parent_price: 9, sub_agent_profit_margin: 3, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } },
      },
      sub_agent_catalog: { data: null, error: { message: "boom" } },
    })
    expect(await verifyBundlePrice("sub1", "p1", "parent1", client)).toBeNull()
  })

  it("sub-agent (old model fallback): valid package → verifiedPrice from basePrice + wholesale_margin + sub_agent_profit_margin", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "pu1" } },
      users: { data: { role: "dealer" } },
      sub_agent_shop_packages: { data: null }, // no row in the new model → falls back
      sub_agent_catalog: {
        data: [{ package_id: "p1", wholesale_margin: 1, sub_agent_profit_margin: 2, packages: { id: "p1", size: "1GB", network: "MTN", price: 10, dealer_price: 8, is_available: true } }],
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
        data: [{ package_id: "p1", wholesale_margin: 1, sub_agent_profit_margin: 2, packages: { id: "p1", size: "1GB", network: "MTN", price: 10, dealer_price: 8, is_available: false } }],
      },
    })

    const result = await verifyBundlePrice("sub1", "p1", "parent1", client)
    expect(result).toBeNull()
  })
})

describe("custom prices (owner saving)", () => {
  it("regular shop: selling price unchanged, profit includes the owner's saving", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer", pricing_mode: "custom" } },
      user_package_prices: { data: [{ package_id: "p1", price: 6 }] },
      shop_packages: { data: { profit_margin: 2, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } },
    })
    // role (dealer) 8 + margin 2 = 10 selling; saving 8 - 6 = 2 -> profit 4
    expect(await verifyBundlePrice("s1", "p1", undefined, client)).toEqual({ verifiedPrice: 10, profitAmount: 4, parentProfitAmount: 0 })
  })

  it("sub-agent new model: price unchanged (role + margin), parent credited wholesale + saving", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "parent" } },
      users: { data: { role: "dealer", pricing_mode: "custom" } },
      user_package_prices: { data: [{ package_id: "p1", price: 6 }] },
      sub_agent_shop_packages: { data: { parent_price: 9, sub_agent_profit_margin: 1, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } },
      sub_agent_catalog: { data: [{ package_id: "p1", wholesale_margin: 1, packages: { id: "p1", size: "1GB", network: "MTN", price: 10, dealer_price: 8, is_available: true } }] },
    })
    // selling 8 + 1 + 1 = 10; parent profit 1 + (8 - 6) = 3
    expect(await verifyBundlePrice("sub", "p1", "parentShop", client)).toEqual({ verifiedPrice: 10, profitAmount: 1, parentProfitAmount: 3 })
  })

  it("sub-agent old model: parent profit = wholesale + saving, selling price unchanged", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "parent" } },
      users: { data: { role: "dealer", pricing_mode: "custom" } },
      user_package_prices: { data: [{ package_id: "p1", price: 6 }] },
      sub_agent_shop_packages: { data: null },
      sub_agent_catalog: { data: [{ package_id: "p1", wholesale_margin: 1, sub_agent_profit_margin: 1, packages: { id: "p1", size: "1GB", network: "MTN", price: 10, dealer_price: 8, is_available: true } }] },
    })
    // selling 8 + 1 + 1 = 10; parent profit 1 + (8 - 6) = 3
    expect(await verifyBundlePrice("sub", "p1", "parentShop", client)).toEqual({ verifiedPrice: 10, profitAmount: 1, parentProfitAmount: 3 })
  })

  it("a custom price above the role price with valid margins still sells, at a negative profit", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "user", pricing_mode: "custom" } },
      user_package_prices: { data: [{ package_id: "p1", price: 15 }] },
      shop_packages: { data: { profit_margin: 2, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } },
    })
    // role (user) 10, custom 15 -> saving -5; margin 2 -> profit -3; selling price stays 10 + 2
    expect(await verifyBundlePrice("s1", "p1", undefined, client)).toEqual({ verifiedPrice: 12, profitAmount: -3, parentProfitAmount: 0 })
  })

  it("a negative wholesale margin is refused (null)", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "parent" } },
      users: { data: { role: "dealer" } },
      sub_agent_shop_packages: { data: null },
      sub_agent_catalog: { data: [{ package_id: "p1", wholesale_margin: -1, sub_agent_profit_margin: 2, packages: { id: "p1", size: "1GB", network: "MTN", price: 10, dealer_price: 8, is_available: true } }] },
    })
    // would underprice the role price: refused, so a negative profit can only come from a custom price
    expect(await verifyBundlePrice("sub", "p1", "parentShop", client)).toBeNull()
  })

  it("a negative shop margin is refused (null)", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer" } },
      shop_packages: { data: { profit_margin: -1, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } },
    })
    expect(await verifyBundlePrice("s1", "p1", undefined, client)).toBeNull()
  })

  it("returns null (refuse) when the owner's custom prices cannot be read", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer", pricing_mode: "custom" } },
      user_package_prices: { data: null, error: { message: "boom" } },
      shop_packages: { data: { profit_margin: 2, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } },
    })
    expect(await verifyBundlePrice("s1", "p1", undefined, client)).toBeNull()
  })

  it("returns null (refuse) when the owner's pricing mode cannot be read", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: null, error: { message: "boom" } },
      shop_packages: { data: { profit_margin: 2, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } },
    })
    expect(await verifyBundlePrice("s1", "p1", undefined, client)).toBeNull()
  })

  it("fetchShopBundles selling prices are unchanged by custom prices", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer", pricing_mode: "custom" } },
      user_package_prices: { data: [{ package_id: "p1", price: 6 }] },
      shop_packages: { data: [{ package_id: "p1", profit_margin: 2 }] },
      packages: { data: [{ id: "p1", size: "1GB", price: 10, dealer_price: 8 }] },
    })
    expect((await fetchShopBundles("s1", "MTN", undefined, client))[0].price).toBe(10)
  })
})

describe("shopOwnerPricing reads (via verifyBundlePrice)", () => {
  const SHOP_PKG = { data: { profit_margin: 2, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } }

  it("no users row: not a dealer, role mode (real PostgREST .single() would error here; .maybeSingle() does not)", async () => {
    const usersChain: any = {
      select: () => usersChain,
      eq: () => usersChain,
      single: () => Promise.resolve({ data: null, error: { code: "PGRST116", message: "0 rows" } }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    }
    const base = fakeClient({ user_shops: { data: { user_id: "u1" } }, shop_packages: SHOP_PKG })
    const client = { from: (t: string) => (t === "users" ? usersChain : base.from(t)) } as any
    expect(await verifyBundlePrice("s1", "p1", undefined, client)).toEqual({ verifiedPrice: 12, profitAmount: 2, parentProfitAmount: 0 })
  })

  it("user_shops read error: refuse (null)", async () => {
    const client = fakeClient({
      user_shops: { data: null, error: { message: "boom" } },
      users: { data: { role: "dealer" } },
      shop_packages: SHOP_PKG,
    })
    expect(await verifyBundlePrice("s1", "p1", undefined, client)).toBeNull()
  })

  it("no user_shops row: default pricing (not a dealer, no custom prices)", async () => {
    const client = fakeClient({ user_shops: { data: null }, shop_packages: SHOP_PKG })
    expect(await verifyBundlePrice("s1", "p1", undefined, client)).toEqual({ verifiedPrice: 12, profitAmount: 2, parentProfitAmount: 0 })
  })

  it("profits are rounded to 2 decimals", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer", pricing_mode: "custom" } },
      user_package_prices: { data: [{ package_id: "p1", price: 7.8 }] },
      shop_packages: { data: { profit_margin: 0.1, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } },
    })
    // margin 0.1 + saving 0.2 is 0.30000000000000004 unrounded
    expect((await verifyBundlePrice("s1", "p1", undefined, client))!.profitAmount).toBe(0.3)
  })
})

describe("directShopPricing / parentProfitFromCatalog (storefront route arithmetic)", () => {
  it("direct shop: total = role + margin, profit = margin + saving", () => {
    expect(directShopPricing({ rolePrice: 8, margin: 2, saving: 2 })).toEqual({ basePrice: 8, totalPrice: 10, profit: 4 })
  })
  it("direct shop: no custom price (saving 0) gives the old values", () => {
    expect(directShopPricing({ rolePrice: 8, margin: 2, saving: 0 })).toEqual({ basePrice: 8, totalPrice: 10, profit: 2 })
    expect(directShopPricing({ rolePrice: 8, margin: -1, saving: 0 })).toEqual({ basePrice: 8, totalPrice: 7, profit: -1 })
  })
  it("direct shop: custom price above role is not clamped", () => {
    expect(directShopPricing({ rolePrice: 10, margin: 2, saving: -5 })).toEqual({ basePrice: 10, totalPrice: 12, profit: -3 })
  })
  it("old-model parent profit = wholesale + saving, rounded; saving 0 gives the old value", () => {
    expect(parentProfitFromCatalog(1, 2)).toBe(3)
    expect(parentProfitFromCatalog(1, 0)).toBe(1)
    expect(parentProfitFromCatalog(-1, 0)).toBe(-1)
    expect(parentProfitFromCatalog(0.1, 0.2)).toBe(0.3)
  })
})

describe("negative margins are refused on every path", () => {
  it("new model: a negative sub_agent_profit_margin -> null", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "parent" } },
      users: { data: { role: "dealer" } },
      sub_agent_shop_packages: { data: { parent_price: 9, sub_agent_profit_margin: -1, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } },
      sub_agent_catalog: { data: [{ package_id: "p1", wholesale_margin: 1, packages: { id: "p1", size: "1GB", network: "MTN", price: 10, dealer_price: 8, is_available: true } }] },
    })
    expect(await verifyBundlePrice("sub", "p1", "parentShop", client)).toBeNull()
  })
  it("old model: a negative sub_agent_profit_margin -> null", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "parent" } },
      users: { data: { role: "dealer" } },
      sub_agent_shop_packages: { data: null },
      sub_agent_catalog: { data: [{ package_id: "p1", wholesale_margin: 1, sub_agent_profit_margin: -2, packages: { id: "p1", size: "1GB", network: "MTN", price: 10, dealer_price: 8, is_available: true } }] },
    })
    expect(await verifyBundlePrice("sub", "p1", "parentShop", client)).toBeNull()
  })
  it("new model: parent profit is rounded to 2 decimals", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "parent" } },
      users: { data: { role: "dealer", pricing_mode: "custom" } },
      user_package_prices: { data: [{ package_id: "p1", price: 7.8 }] },
      sub_agent_shop_packages: { data: { parent_price: 99, sub_agent_profit_margin: 1, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } },
      sub_agent_catalog: { data: [{ package_id: "p1", wholesale_margin: 0.1, packages: { id: "p1", size: "1GB", network: "MTN", price: 10, dealer_price: 8, is_available: true } }] },
    })
    // wholesale 0.1 + saving 0.2 is 0.30000000000000004 unrounded
    expect((await verifyBundlePrice("sub", "p1", "parentShop", client))!.parentProfitAmount).toBe(0.3)
  })
  it("new model: a negative parent wholesale margin -> null", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "parent" } },
      users: { data: { role: "dealer" } },
      sub_agent_shop_packages: { data: { parent_price: 9, sub_agent_profit_margin: 1, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } },
      sub_agent_catalog: { data: [{ package_id: "p1", wholesale_margin: -1, packages: { id: "p1", size: "1GB", network: "MTN", price: 10, dealer_price: 8, is_available: true } }] },
    })
    expect(await verifyBundlePrice("sub", "p1", "parentShop", client)).toBeNull()
  })
})

describe("marginsValid", () => {
  it("accepts finite margins >= 0", () => {
    expect(marginsValid(0, 1.5, 2)).toBe(true)
    expect(marginsValid()).toBe(true)
  })
  it("rejects negative or non-finite margins", () => {
    expect(marginsValid(1, -0.01)).toBe(false)
    expect(marginsValid(NaN)).toBe(false)
    expect(marginsValid(Infinity)).toBe(false)
  })
})

describe("catalogWholesaleMargin (old-model storefront row)", () => {
  it("a parent's own row uses its own wholesale margin", () => {
    expect(catalogWholesaleMargin({ shop_id: "parent", wholesale_margin: 1 }, "sub", null)).toBe(1)
  })
  it("a sub-agent's own-shop row with a negative wholesale margin does not lower the price: the parent's margin is used", () => {
    expect(catalogWholesaleMargin({ shop_id: "sub", wholesale_margin: -5 }, "sub", { wholesale_margin: 1 })).toBe(1)
  })
  it("a sub-agent's own-shop row with no active parent row -> null (refuse)", () => {
    expect(catalogWholesaleMargin({ shop_id: "sub", wholesale_margin: 1 }, "sub", null)).toBeNull()
  })
  it("a missing margin counts as 0, as before", () => {
    expect(catalogWholesaleMargin({ shop_id: "parent", wholesale_margin: null }, "sub", null)).toBe(0)
    expect(catalogWholesaleMargin({ shop_id: "sub", wholesale_margin: 3 }, "sub", { wholesale_margin: null })).toBe(0)
  })
})

// Live sub-agent cost: parent role price + the parent's ACTIVE wholesale margin. Stored parent_price is never read.
describe("subAgentCosts", () => {
  const PKG = { id: "p1", size: "1GB", network: "MTN", price: 10, dealer_price: 8, is_available: true }
  const row = (over: Record<string, unknown> = {}) => ({ package_id: "p1", wholesale_margin: 2, parent_price: 9, packages: PKG, ...over })
  const parentTables = (role = "agent", extra: Record<string, { data: unknown; error?: unknown }> = {}) => ({
    user_shops: { data: { user_id: "parent" } },
    users: { data: { role } },
    ...extra,
  })

  it("prices a stale snapshot live: role 10 (non-dealer) + margin 2 = 12, parent credited 2", async () => {
    const client = fakeClient({ ...parentTables(), sub_agent_catalog: { data: [row()] } })
    const { costs, parent } = await subAgentCosts("parentShop", ["p1"], client)
    expect(parent.isDealer).toBe(false)
    expect(costs.get("p1")).toMatchObject({ cost: 12, wholesale: 2, parentProfit: 2 })
  })

  it("a dealer (or admin) parent's cost uses dealer_price: 8 + 2 = 10, ignoring parent_price 9", async () => {
    for (const role of ["dealer", "admin"]) {
      const client = fakeClient({ ...parentTables(role), sub_agent_catalog: { data: [row()] } })
      expect((await subAgentCosts("parentShop", ["p1"], client)).costs.get("p1")).toMatchObject({ cost: 10, parentProfit: 2 })
    }
  })

  it("a parent on custom pricing: cost unchanged (role + margin), parent credited margin + saving", async () => {
    const client = fakeClient({
      ...parentTables("dealer", { users: { data: { role: "dealer", pricing_mode: "custom" } }, user_package_prices: { data: [{ package_id: "p1", price: 6 }] } }),
      sub_agent_catalog: { data: [row()] },
    })
    // cost 8 + 2 = 10; profit 2 + (8 - 6) = 4
    expect((await subAgentCosts("parentShop", ["p1"], client)).costs.get("p1")).toMatchObject({ cost: 10, parentProfit: 4 })
  })

  it("no active parent row: the package is not offered (null)", async () => {
    const client = fakeClient({ ...parentTables(), sub_agent_catalog: { data: [] } })
    expect((await subAgentCosts("parentShop", ["p1"], client)).costs.get("p1")).toBeNull()
  })

  it("an unavailable package or a negative margin is not offered", async () => {
    const off = fakeClient({ ...parentTables(), sub_agent_catalog: { data: [row({ packages: { ...PKG, is_available: false } })] } })
    expect((await subAgentCosts("parentShop", ["p1"], off)).costs.get("p1")).toBeNull()
    const neg = fakeClient({ ...parentTables(), sub_agent_catalog: { data: [row({ wholesale_margin: -1 })] } })
    expect((await subAgentCosts("parentShop", ["p1"], neg)).costs.get("p1")).toBeNull()
  })

  it("only returns the requested packages, and every offered one when none are named", async () => {
    const rows = [row(), row({ package_id: "p2", packages: { ...PKG, id: "p2" } })]
    const client = fakeClient({ ...parentTables(), sub_agent_catalog: { data: rows } })
    expect([...(await subAgentCosts("parentShop", ["p2"], client)).costs.keys()]).toEqual(["p2"])
    expect([...(await subAgentCosts("parentShop", null, client)).costs.keys()]).toEqual(["p1", "p2"])
  })

  it("throws CustomPriceReadError when the catalog or the parent's pricing cannot be read", async () => {
    const cat = fakeClient({ ...parentTables(), sub_agent_catalog: { data: null, error: { message: "boom" } } })
    await expect(subAgentCosts("parentShop", ["p1"], cat)).rejects.toBeInstanceOf(CustomPriceReadError)
    const own = fakeClient({ ...parentTables(), users: { data: null, error: { message: "boom" } }, sub_agent_catalog: { data: [row()] } })
    await expect(subAgentCosts("parentShop", ["p1"], own)).rejects.toBeInstanceOf(CustomPriceReadError)
  })
})

describe("subAgentBundles (USSD / WhatsApp sub_agent menus)", () => {
  it("lists the parent's offered packages at live cost, cheapest first, then by id", async () => {
    const pkg = (id: string, price: number) => ({ id, size: "1", network: "MTN", price, dealer_price: null, is_available: true })
    const client = fakeClient({
      user_shops: { data: { user_id: "parent" } },
      users: { data: { role: "agent" } },
      sub_agent_catalog: {
        data: [
          { package_id: "b", wholesale_margin: 1, parent_price: 1, packages: pkg("b", 10) },
          { package_id: "a", wholesale_margin: 2, parent_price: 99, packages: pkg("a", 9) },
          { package_id: "c", wholesale_margin: 0, parent_price: 5, packages: pkg("c", 20) },
        ],
      },
    })
    expect(await subAgentBundles("parentShop", "MTN", client)).toEqual([
      { id: "a", size: "1", price: 11 },
      { id: "b", size: "1", price: 11 },
      { id: "c", size: "1", price: 20 },
    ])
  })
})
