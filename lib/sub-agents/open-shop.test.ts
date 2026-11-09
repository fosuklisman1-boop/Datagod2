import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ subAgentCosts: vi.fn() }))
vi.mock("@/lib/shop-commerce/pricing", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shop-commerce/pricing")>("@/lib/shop-commerce/pricing")
  return { ...actual, subAgentCosts: h.subAgentCosts }
})

import {
  openPricedShop,
  getShopPublicState,
  applyAdminShopStatus,
  listStorefrontJoiners,
  approveShop,
  subAgentRemovalUpdate,
  ShopNotFoundError,
} from "./open-shop"
import { CustomPriceReadError } from "@/lib/pricing/package-price"

type Q = {
  table: string
  op: "select" | "update" | "insert"
  payload?: any
  columns?: string
  filters: Array<[string, ...any[]]>
  terminal?: string
}

/** Records every query; `respond` decides each result. */
function fakeDb(respond: (q: Q) => { data: any; error: any }) {
  const queries: Q[] = []
  const db: any = {
    from(table: string) {
      const q: Q = { table, op: "select", filters: [] }
      queries.push(q)
      const run = (terminal: string) => { q.terminal = terminal; return respond(q) }
      const chain: any = {
        select(cols?: string) { if (q.op === "select") q.columns = cols; return chain },
        update(p: any) { q.op = "update"; q.payload = p; return chain },
        insert(p: any) { q.op = "insert"; q.payload = p; return chain },
        async single() { return run("single") },
        async maybeSingle() { return run("maybeSingle") },
        then(res: any, rej: any) { return Promise.resolve(run("then")).then(res, rej) },
      }
      for (const m of ["eq", "is", "not", "or", "in", "order", "limit", "range", "neq"]) {
        chain[m] = (...args: any[]) => { q.filters.push([m, ...args]); return chain }
      }
      return chain
    },
  }
  return { db, queries }
}

const has = (q: Q, ...f: any[]) => q.filters.some(x => JSON.stringify(x) === JSON.stringify(f))

const JOINER = {
  id: "shop-j", is_active: false, is_blocked: false, joined_via: "storefront", prices_set_at: null,
  parent_shop_id: "parent-1", subdomain: "kofi",
}

function offer(id: string) {
  return { cost: 5, wholesale: 1, parentProfit: 1, pkg: { id, size: "1GB", network: "MTN", price: 5, dealer_price: 4 } }
}

/** A world for openPricedShop: the user's shop, their saved rows, and what the update matches. */
function openWorld(o: {
  shop?: any
  rows?: any[] | null
  rowsError?: any
  updateMatches?: boolean
  reread?: any
}) {
  let shopReads = 0
  return fakeDb(q => {
    if (q.table === "user_shops" && q.op === "select") {
      shopReads++
      return { data: shopReads === 1 ? (o.shop === undefined ? JOINER : o.shop) : (o.reread ?? null), error: null }
    }
    if (q.table === "user_shops" && q.op === "update") {
      return { data: o.updateMatches === false ? [] : [{ id: "shop-j" }], error: null }
    }
    if (q.table === "sub_agent_shop_packages") return { data: o.rows === undefined ? [] : o.rows, error: o.rowsError ?? null }
    if (q.table === "ussd_shop_codes") return { data: { code: "4321" }, error: null }
    return { data: null, error: null }
  })
}

const updates = (queries: Q[]) => queries.filter(q => q.table === "user_shops" && q.op === "update")

beforeEach(() => {
  h.subAgentCosts.mockReset()
  h.subAgentCosts.mockImplementation(async (_parent: string, ids: string[]) => ({
    parent: {},
    costs: new Map(ids.map(id => [id, offer(id)])),
  }))
})

describe("openPricedShop", () => {
  it("no saved rows: no_prices, nothing written", async () => {
    const { db, queries } = openWorld({ rows: [] })
    expect(await openPricedShop(db, "u1")).toEqual({ status: "no_prices" })
    expect(updates(queries)).toHaveLength(0)
  })

  it("only negative-margin rows: no_prices", async () => {
    const { db, queries } = openWorld({ rows: [{ package_id: "p1", sub_agent_profit_margin: -0.5 }] })
    expect((await openPricedShop(db, "u1")).status).toBe("no_prices")
    expect(updates(queries)).toHaveLength(0)
  })

  it("rows the parent no longer offers (subAgentCosts null): no_prices", async () => {
    h.subAgentCosts.mockImplementation(async (_p: string, ids: string[]) => ({
      parent: {}, costs: new Map(ids.map(id => [id, null])),
    }))
    const { db, queries } = openWorld({ rows: [{ package_id: "p1", sub_agent_profit_margin: 2 }] })
    expect((await openPricedShop(db, "u1")).status).toBe("no_prices")
    expect(h.subAgentCosts).toHaveBeenCalledWith("parent-1", ["p1"], db)
    expect(updates(queries)).toHaveLength(0)
  })

  it("only reads active saved rows of the user's own shop", async () => {
    const { db, queries } = openWorld({ rows: [] })
    await openPricedShop(db, "u1")
    const shopRead = queries.find(q => q.table === "user_shops")!
    expect(has(shopRead, "eq", "user_id", "u1")).toBe(true)
    const rowsRead = queries.find(q => q.table === "sub_agent_shop_packages")!
    expect(has(rowsRead, "eq", "shop_id", "shop-j")).toBe(true)
    expect(has(rowsRead, "eq", "is_active", true)).toBe(true)
  })

  it("a zero-margin row opens the shop (Review Focus 5), with a conditional update", async () => {
    const { db, queries } = openWorld({ rows: [{ package_id: "p1", sub_agent_profit_margin: 0 }] })
    const r = await openPricedShop(db, "u1")
    expect(r).toEqual({ status: "opened", ussdCode: "4321", subdomain: "kofi" })
    const [up] = updates(queries)
    expect(up.payload).toMatchObject({ is_active: true })
    expect(typeof up.payload.prices_set_at).toBe("string")
    expect(has(up, "eq", "id", "shop-j")).toBe(true)
    expect(has(up, "is", "prices_set_at", null)).toBe(true)
    expect(has(up, "not", "is_blocked", "is", true)).toBe(true)
    expect(has(up, "eq", "joined_via", "storefront")).toBe(true)
  })

  it("a mix of a negative row and an offered row opens; only the valid row is priced", async () => {
    const { db } = openWorld({
      rows: [{ package_id: "p1", sub_agent_profit_margin: -1 }, { package_id: "p2", sub_agent_profit_margin: 1.5 }],
    })
    expect((await openPricedShop(db, "u1")).status).toBe("opened")
    expect(h.subAgentCosts).toHaveBeenCalledWith("parent-1", ["p2"], db)
  })

  it("a null margin is not a saved price", async () => {
    const { db } = openWorld({ rows: [{ package_id: "p1", sub_agent_profit_margin: null }] })
    expect((await openPricedShop(db, "u1")).status).toBe("no_prices")
  })

  it("opening twice: already_open, no second write", async () => {
    const { db, queries } = openWorld({
      shop: { ...JOINER, is_active: true, prices_set_at: "2026-11-03T00:00:00Z" },
      rows: [{ package_id: "p1", sub_agent_profit_margin: 1 }],
    })
    expect(await openPricedShop(db, "u1")).toEqual({ status: "already_open", ussdCode: "4321", subdomain: "kofi" })
    expect(updates(queries)).toHaveLength(0)
  })

  it("lost a race to a parallel open: the conditional update matches nothing, already_open", async () => {
    const { db, queries } = openWorld({
      rows: [{ package_id: "p1", sub_agent_profit_margin: 1 }],
      updateMatches: false,
      reread: { ...JOINER, is_active: true, prices_set_at: "2026-11-03T00:00:00Z" },
    })
    expect((await openPricedShop(db, "u1")).status).toBe("already_open")
    expect(updates(queries)).toHaveLength(1)
  })

  it("blocked between the read and the update: stays closed, blocked", async () => {
    const { db } = openWorld({
      rows: [{ package_id: "p1", sub_agent_profit_margin: 1 }],
      updateMatches: false,
      reread: { ...JOINER, is_blocked: true },
    })
    expect((await openPricedShop(db, "u1")).status).toBe("blocked")
  })

  it("a blocked shop stays closed even when priced", async () => {
    const { db, queries } = openWorld({ shop: { ...JOINER, is_blocked: true }, rows: [{ package_id: "p1", sub_agent_profit_margin: 1 }] })
    expect((await openPricedShop(db, "u1")).status).toBe("blocked")
    expect(updates(queries)).toHaveLength(0)
  })

  it("an invited sub-agent's closed shop is not changed", async () => {
    const { db, queries } = openWorld({ shop: { ...JOINER, joined_via: null }, rows: [{ package_id: "p1", sub_agent_profit_margin: 1 }] })
    expect((await openPricedShop(db, "u1")).status).toBe("blocked")
    expect(updates(queries)).toHaveLength(0)
  })

  it("a main shop awaiting approval is not changed", async () => {
    const { db, queries } = openWorld({ shop: { ...JOINER, joined_via: null, parent_shop_id: null } })
    expect((await openPricedShop(db, "u1")).status).toBe("blocked")
    expect(updates(queries)).toHaveLength(0)
  })

  it("an active invite or main shop reports already_open and is not written", async () => {
    const { db, queries } = openWorld({ shop: { ...JOINER, joined_via: null, is_active: true } })
    expect((await openPricedShop(db, "u1")).status).toBe("already_open")
    expect(updates(queries)).toHaveLength(0)
  })

  it("a joiner closed by an admin after opening (prices_set_at set) cannot reopen itself", async () => {
    const { db, queries } = openWorld({
      shop: { ...JOINER, prices_set_at: "2026-11-01T00:00:00Z" },
      rows: [{ package_id: "p1", sub_agent_profit_margin: 1 }],
    })
    expect((await openPricedShop(db, "u1")).status).toBe("blocked")
    expect(updates(queries)).toHaveLength(0)
  })

  it("a CustomPriceReadError is retryable: it propagates and nothing opens", async () => {
    h.subAgentCosts.mockRejectedValue(new CustomPriceReadError())
    const { db, queries } = openWorld({ rows: [{ package_id: "p1", sub_agent_profit_margin: 1 }] })
    await expect(openPricedShop(db, "u1")).rejects.toBeInstanceOf(CustomPriceReadError)
    expect(updates(queries)).toHaveLength(0)
  })

  it("a failed read of the saved rows is retryable, not no_prices", async () => {
    const { db, queries } = openWorld({ rows: null, rowsError: { message: "boom" } })
    await expect(openPricedShop(db, "u1")).rejects.toBeInstanceOf(CustomPriceReadError)
    expect(updates(queries)).toHaveLength(0)
  })

  it("no shop: ShopNotFoundError", async () => {
    const { db } = openWorld({ shop: null })
    await expect(openPricedShop(db, "u1")).rejects.toBeInstanceOf(ShopNotFoundError)
  })
})

describe("getShopPublicState", () => {
  const world = (rows: any[] | null, error: any = null) => fakeDb(() => ({ data: rows, error }))

  it("active shop: open", async () => {
    expect(await getShopPublicState("kofi", world([{ is_active: true, is_blocked: false, joined_via: null, prices_set_at: null }]).db)).toBe("open")
  })
  it("unpriced storefront joiner: setting_up", async () => {
    expect(await getShopPublicState("kofi", world([{ is_active: false, is_blocked: false, joined_via: "storefront", prices_set_at: null }]).db)).toBe("setting_up")
  })
  it("blocked unpriced joiner: missing", async () => {
    expect(await getShopPublicState("kofi", world([{ is_active: false, is_blocked: true, joined_via: "storefront", prices_set_at: null }]).db)).toBe("missing")
  })
  it("inactive main shop or closed-after-opening joiner: missing", async () => {
    expect(await getShopPublicState("kofi", world([{ is_active: false, is_blocked: false, joined_via: null, prices_set_at: null }]).db)).toBe("missing")
    expect(await getShopPublicState("kofi", world([{ is_active: false, is_blocked: false, joined_via: "storefront", prices_set_at: "2026-11-01" }]).db)).toBe("missing")
  })
  it("no row, two rows, an error or a blank handle: missing", async () => {
    expect(await getShopPublicState("kofi", world([]).db)).toBe("missing")
    expect(await getShopPublicState("kofi", world([{ is_active: true }, { is_active: true }]).db)).toBe("missing")
    expect(await getShopPublicState("kofi", world(null, { message: "x" }).db)).toBe("missing")
    expect(await getShopPublicState("  ", world([{ is_active: true }]).db)).toBe("missing")
  })
  it("resolves the handle through shopHandleOrFilter", async () => {
    const { db, queries } = world([])
    await getShopPublicState("Kofi", db)
    expect(queries[0].filters.some(f => f[0] === "or")).toBe(true)
  })
})

describe("admin queue", () => {
  it("status=pending: inactive shops that did not join through a storefront", () => {
    const { db, queries } = fakeDb(() => ({ data: [], error: null }))
    applyAdminShopStatus(db.from("user_shops").select("*"), "pending")
    expect(has(queries[0], "eq", "is_active", false)).toBe(true)
    expect(has(queries[0], "is", "joined_via", null)).toBe(true)
  })

  it("status=active unchanged; no status adds no filter", () => {
    const a = fakeDb(() => ({ data: [], error: null }))
    applyAdminShopStatus(a.db.from("user_shops").select("*"), "active")
    expect(a.queries[0].filters).toEqual([["eq", "is_active", true]])
    const b = fakeDb(() => ({ data: [], error: null }))
    applyAdminShopStatus(b.db.from("user_shops").select("*"), null)
    expect(b.queries[0].filters).toEqual([])
  })

  it("status=storefront_joiners: joiners newest first, with their parent shop", async () => {
    const { db, queries } = fakeDb(q => {
      if (q.filters.some(f => f[0] === "eq" && f[1] === "joined_via")) {
        return {
          data: [
            { id: "j2", shop_name: "Two", parent_shop_id: "p1", created_at: "2026-11-02" },
            { id: "j1", shop_name: "One", parent_shop_id: "p2", created_at: "2026-11-01" },
          ],
          error: null,
        }
      }
      return { data: [{ id: "p1", shop_name: "Parent One" }, { id: "p2", shop_name: "Parent Two" }], error: null }
    })
    const rows = await listStorefrontJoiners(db, 50)
    const q = queries[0]
    expect(has(q, "eq", "joined_via", "storefront")).toBe(true)
    expect(q.filters.find(f => f[0] === "order")).toEqual(["order", "created_at", { ascending: false }])
    expect(rows.map(r => [r.id, r.parent_shop_name])).toEqual([["j2", "Parent One"], ["j1", "Parent Two"]])
  })

  it("listStorefrontJoiners throws on a read error", async () => {
    const { db } = fakeDb(() => ({ data: null, error: { message: "boom" } }))
    await expect(listStorefrontJoiners(db, 50)).rejects.toBeTruthy()
  })
})

describe("approveShop", () => {
  it("approves a normal pending shop with a conditional update that excludes closed joiners", async () => {
    const { db, queries } = fakeDb(q => q.op === "update" ? { data: [{ id: "s1", user_id: "u", shop_name: "S" }], error: null } : { data: null, error: null })
    const r = await approveShop(db, "s1")
    expect(r.status).toBe("approved")
    const up = queries.find(q => q.op === "update")!
    expect(up.payload).toMatchObject({ is_active: true })
    expect(has(up, "eq", "is_active", false)).toBe(true)
    expect(has(up, "or", "joined_via.is.null,prices_set_at.not.is.null")).toBe(true)
  })

  it("refuses a closed storefront joiner", async () => {
    const { db } = fakeDb(q => q.op === "update"
      ? { data: [], error: null }
      : { data: { is_active: false, joined_via: "storefront", prices_set_at: null }, error: null })
    expect((await approveShop(db, "s1")).status).toBe("opens_when_priced")
  })

  it("an already active shop: already_approved", async () => {
    const { db } = fakeDb(q => q.op === "update"
      ? { data: [], error: null }
      : { data: { is_active: true, joined_via: null, prices_set_at: null }, error: null })
    expect((await approveShop(db, "s1")).status).toBe("already_approved")
  })

  it("throws on an update error", async () => {
    const { db } = fakeDb(() => ({ data: null, error: { message: "x" } }))
    await expect(approveShop(db, "s1")).rejects.toBeTruthy()
  })
})

describe("subAgentRemovalUpdate", () => {
  it("storefront joiner: detached, closed, flag cleared, dealer rates off (lands in the normal admin queue)", () => {
    expect(subAgentRemovalUpdate({ joined_via: "storefront" })).toEqual({
      parent_shop_id: null, tier_level: 1, is_active: false, joined_via: null, dealer_rates_enabled: false,
    })
  })
  it("invited sub-agent: as today, only detached", () => {
    expect(subAgentRemovalUpdate({ joined_via: null })).toEqual({ parent_shop_id: null, tier_level: 1 })
    expect(subAgentRemovalUpdate({})).toEqual({ parent_shop_id: null, tier_level: 1 })
  })
})
