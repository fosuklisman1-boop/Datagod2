import { describe, it, expect } from "vitest"
import { MSG_PRICES_UNAVAILABLE } from "@/lib/pricing/package-price"
import { loadPublicShopPackages } from "./public-packages"

// Fake Supabase client: each read is answered by `respond(table, filters)`, where filters are the
// .eq()/.in() calls made on the chain, so the sub-agent's own rows and the parent's catalog
// (both sub_agent_catalog) can be told apart by shop_id.
type Result = { data: unknown; error?: unknown }
type Filters = Record<string, unknown>
const first = (r: Result) => (Array.isArray(r.data) ? { ...r, data: r.data[0] ?? null } : r)

function fakeClient(respond: (table: string, f: Filters) => Result) {
  return {
    from: (table: string) => {
      const f: Filters = {}
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => ((f[k] = v), chain),
        in: (k: string, v: unknown) => ((f[k] = v), chain),
        order: () => chain,
        limit: () => chain,
        single: () => Promise.resolve(first(respond(table, f))),
        maybeSingle: () => Promise.resolve(first(respond(table, f))),
        then: (res: any, rej: any) => Promise.resolve(respond(table, f)).then(res, rej),
      }
      return chain
    },
  } as any
}

const PKG = (id: string, over: Record<string, unknown> = {}) => ({
  id, network: "MTN", size: "1GB", price: 10, dealer_price: 8, description: "d", is_available: true, ...over,
})

const SUB = { id: "sub", user_id: "subUser", parent_shop_id: "parent" }
const REGULAR = { id: "shop", user_id: "owner", parent_shop_id: null }

function subAgentWorld(opts: {
  parentRole?: string
  parentCatalog?: Result
  sapRows?: Result
  ownCatalog?: Result
  parentUsersError?: boolean
}) {
  return fakeClient((table, f) => {
    if (table === "users") {
      if (f.id === "parentUser") return opts.parentUsersError ? { data: null, error: { message: "boom" } } : { data: { role: opts.parentRole ?? "agent", pricing_mode: null } }
      return { data: { role: "agent" } }
    }
    if (table === "user_shops") return { data: { user_id: f.id === "parent" ? "parentUser" : "subUser" } }
    if (table === "sub_agent_shop_packages") return opts.sapRows ?? { data: [] }
    if (table === "sub_agent_catalog") {
      if (f.shop_id === "parent") return opts.parentCatalog ?? { data: [] }
      return opts.ownCatalog ?? { data: [] }
    }
    return { data: null }
  })
}

// The parent's active catalog row, as subAgentCosts reads it (packages!inner).
const parentRow = (id: string, wholesale: number, over: Record<string, unknown> = {}) => ({
  package_id: id, wholesale_margin: wholesale, packages: PKG(id, over),
})

describe("loadPublicShopPackages: new-model sub-agent (sub_agent_shop_packages)", () => {
  it("prices live: parent role price + parent's active wholesale margin + sub-agent margin; stored parent_price ignored", async () => {
    const client = subAgentWorld({
      parentRole: "dealer",
      parentCatalog: { data: [parentRow("p1", 2)] },
      sapRows: { data: [{ id: "s1", package_id: "p1", parent_price: 99, sub_agent_profit_margin: 1.5, is_active: true, package: PKG("p1") }] },
    })
    const r = await loadPublicShopPackages(client, SUB)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // dealer parent: 8 + 2 = 10 cost, + 1.5 = 11.5
    expect(r.packages).toEqual([{
      id: "s1", package_id: "p1", profit_margin: 1.5, parent_price: 10, is_available: true,
      packages: { id: "p1", network: "MTN", size: "1GB", price: 10, description: "d" },
      selling_price: 11.5,
    }])
    expect([...r.exactPriceIds]).toEqual(["s1"])
  })

  it("hides packages the parent no longer offers, unavailable packages and negative sub-agent margins", async () => {
    const client = subAgentWorld({
      parentCatalog: { data: [parentRow("p1", 2), parentRow("p3", 1)] },
      sapRows: {
        data: [
          { id: "s1", package_id: "p1", sub_agent_profit_margin: 1, is_active: true, package: PKG("p1") },
          { id: "s2", package_id: "p2", sub_agent_profit_margin: 1, is_active: true, package: PKG("p2") }, // not offered
          { id: "s3", package_id: "p3", sub_agent_profit_margin: -1, is_active: true, package: PKG("p3") }, // negative
          { id: "s4", package_id: "p1", sub_agent_profit_margin: 1, is_active: true, package: PKG("p1", { is_available: false }) },
        ],
      },
    })
    const r = await loadPublicShopPackages(client, SUB)
    if (!r.ok) throw new Error("expected ok")
    expect(r.packages.map((p) => [p.id, p.selling_price])).toEqual([["s1", 13]])
    expect([...r.exactPriceIds]).toEqual(["s1"])
  })

  it("rounds the selling price to 2 dp like the order route", async () => {
    const client = subAgentWorld({
      parentCatalog: { data: [parentRow("p1", 0.1, { price: 0.2 })] },
      sapRows: { data: [{ id: "s1", package_id: "p1", sub_agent_profit_margin: 0.1, is_active: true, package: PKG("p1") }] },
    })
    const r = await loadPublicShopPackages(client, SUB)
    if (!r.ok) throw new Error("expected ok")
    expect(r.packages[0].selling_price).toBe(0.4)
  })

  it("503 when the parent's catalog or pricing cannot be read", async () => {
    const cat = subAgentWorld({
      parentCatalog: { data: null, error: { message: "boom" } },
      sapRows: { data: [{ id: "s1", package_id: "p1", sub_agent_profit_margin: 1, is_active: true, package: PKG("p1") }] },
    })
    expect(await loadPublicShopPackages(cat, SUB)).toEqual({ ok: false, status: 503, error: MSG_PRICES_UNAVAILABLE })
    const owner = subAgentWorld({
      parentUsersError: true,
      parentCatalog: { data: [parentRow("p1", 2)] },
      sapRows: { data: [{ id: "s1", package_id: "p1", sub_agent_profit_margin: 1, is_active: true, package: PKG("p1") }] },
    })
    expect(await loadPublicShopPackages(owner, SUB)).toEqual({ ok: false, status: 503, error: MSG_PRICES_UNAVAILABLE })
  })

  it("500 when the sub-agent's own packages cannot be read", async () => {
    const client = subAgentWorld({ sapRows: { data: null, error: { code: "XX000", message: "boom" } } })
    expect(await loadPublicShopPackages(client, SUB)).toEqual({ ok: false, status: 500, error: "Failed to fetch packages" })
  })
})

describe("loadPublicShopPackages: old-model own-shop sub_agent_catalog rows", () => {
  it("cost from the PARENT's active row (own-shop wholesale_margin never used as cost); sub-agent margin = sub_agent_profit_margin ?? wholesale_margin", async () => {
    const client = subAgentWorld({
      parentCatalog: { data: [parentRow("p1", 2), parentRow("p2", 3)] },
      ownCatalog: {
        data: [
          { id: "c1", package_id: "p1", shop_id: "sub", sub_agent_profit_margin: null, wholesale_margin: 4, is_active: true, package: PKG("p1") },
          { id: "c2", package_id: "p2", shop_id: "sub", sub_agent_profit_margin: 1, wholesale_margin: 50, is_active: true, package: PKG("p2") },
        ],
      },
    })
    const r = await loadPublicShopPackages(client, SUB)
    if (!r.ok) throw new Error("expected ok")
    // c1: 10 + 2 (parent) + 4 (legacy margin in wholesale_margin) = 16; c2: 10 + 3 + 1 = 14
    expect(r.packages.map((p) => [p.id, p.parent_price, p.profit_margin, p.selling_price])).toEqual([
      ["c1", 12, 4, 16],
      ["c2", 13, 1, 14],
    ])
    expect([...r.exactPriceIds].sort()).toEqual(["c1", "c2"])
  })

  it("hides rows the parent does not offer and negative legacy margins", async () => {
    const client = subAgentWorld({
      parentCatalog: { data: [parentRow("p1", 2)] },
      ownCatalog: {
        data: [
          { id: "c1", package_id: "p1", shop_id: "sub", sub_agent_profit_margin: null, wholesale_margin: -1, is_active: true, package: PKG("p1") },
          { id: "c2", package_id: "p2", shop_id: "sub", sub_agent_profit_margin: 1, is_active: true, package: PKG("p2") },
        ],
      },
    })
    const r = await loadPublicShopPackages(client, SUB)
    if (!r.ok) throw new Error("expected ok")
    expect(r.packages).toEqual([])
  })
})

describe("loadPublicShopPackages: regular shops (shop_packages)", () => {
  const world = (role: string, rows: unknown[], usersError?: unknown) =>
    fakeClient((table) => {
      if (table === "users") return usersError ? { data: null, error: usersError } : { data: { role } }
      if (table === "shop_packages") return { data: rows }
      return { data: null }
    })
  const row = (id: string, margin: unknown, pkg = PKG("p1")) => ({ id, package_id: pkg.id, profit_margin: margin, is_available: true, custom_name: null, packages: pkg })

  it("dealer/admin owners sell at dealer_price + margin, others at price + margin; all exact", async () => {
    for (const [role, expected] of [["dealer", 10], ["admin", 10], ["agent", 12]] as const) {
      const r = await loadPublicShopPackages(world(role, [row("a", 2)]), REGULAR)
      if (!r.ok) throw new Error("expected ok")
      expect(r.packages[0]).toMatchObject({ id: "a", profit_margin: 2, custom_name: null, selling_price: expected, packages: { price: expected - 2 } })
      expect([...r.exactPriceIds]).toEqual(["a"])
    }
  })

  it("drops admin-disabled packages", async () => {
    const r = await loadPublicShopPackages(world("agent", [row("a", 2, PKG("p1", { is_available: false }))]), REGULAR)
    if (!r.ok) throw new Error("expected ok")
    expect(r.packages).toEqual([])
  })

  it("lists a negative-margin row (as main's route does) but never marks it exact: the order route refuses it", async () => {
    const r = await loadPublicShopPackages(world("agent", [row("a", -1), row("b", 1)]), REGULAR)
    if (!r.ok) throw new Error("expected ok")
    expect(r.packages.map((p) => p.id)).toEqual(["a", "b"])
    expect([...r.exactPriceIds]).toEqual(["b"])
  })

  it("an unreadable owner role marks nothing exact (checkout might charge the dealer price)", async () => {
    const r = await loadPublicShopPackages(world("dealer", [row("a", 2)], { code: "XX000", message: "boom" }), REGULAR)
    if (!r.ok) throw new Error("expected ok")
    expect(r.packages[0].selling_price).toBe(12)
    expect(r.exactPriceIds.size).toBe(0)
  })

  it("500 when shop_packages cannot be read", async () => {
    const client = fakeClient((table) => (table === "shop_packages" ? { data: null, error: { message: "boom" } } : { data: { role: "agent" } }))
    expect(await loadPublicShopPackages(client, REGULAR)).toEqual({ ok: false, status: 500, error: "Failed to fetch packages" })
  })
})
