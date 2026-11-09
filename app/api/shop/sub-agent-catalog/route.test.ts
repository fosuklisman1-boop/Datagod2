// app/api/shop/sub-agent-catalog/route.test.ts
// GET for a sub-agent shows only what the parent currently offers, at the parent's LIVE cost (role price + the
// parent's active wholesale margin); the stored parent_price is never used. The parent's own view is unchanged.
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  type T = { data: unknown; error?: unknown }
  const state = { tables: {} as Record<string, T>, userId: "sub-user" }
  const first = (r: T) => (Array.isArray(r.data) ? { ...r, data: r.data[0] ?? null } : r)
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: state.userId } }, error: null }) },
    from(table: string) {
      const r = () => ({ error: null, ...(state.tables[table] ?? { data: null }) })
      const b: any = {
        select: () => b, insert: () => b, update: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b,
        single: async () => first(r()),
        maybeSingle: async () => first(r()),
        then: (ok: any, ko: any) => Promise.resolve(r()).then(ok, ko),
      }
      return b
    },
  }
  return { state, client }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.client }))

import { GET, POST, PUT } from "./route"
import * as openShop from "@/lib/sub-agents/open-shop"

vi.mock("@/lib/sub-agents/open-shop", () => ({ openPricedShop: vi.fn() }))

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://x"
process.env.SUPABASE_SERVICE_ROLE_KEY = "k"

const PKG = (id: string) => ({ id, network: "MTN", size: "1", price: 10, dealer_price: 8, description: "", is_available: true })
const get = async () => {
  const res = await GET(new Request("http://x/api/shop/sub-agent-catalog", { headers: { Authorization: "Bearer t" } }) as any)
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  h.state.userId = "sub-user"
  h.state.tables = {
    // Read twice: the sub-agent's own shop (has a parent), then the parent's shop owner lookup (user_id).
    user_shops: { data: { id: "sub-shop", parent_shop_id: "parent-shop", user_id: "parent-user" } },
    users: { data: { role: "dealer" } },
    sub_agent_shop_packages: {
      data: [
        { id: "r1", package_id: "p1", parent_price: 9, sub_agent_profit_margin: 1, is_active: true, package: PKG("p1") },
        { id: "r2", package_id: "p2", parent_price: 5, sub_agent_profit_margin: 1, is_active: true, package: PKG("p2") },
      ],
    },
    // The parent's ACTIVE catalog: only p1 is offered, at margin 2.
    sub_agent_catalog: { data: [{ package_id: "p1", wholesale_margin: 2, packages: PKG("p1") }] },
    shop_packages: { data: [{ package_id: "p2", profit_margin: 0 }] },
  }
})

describe("GET /api/shop/sub-agent-catalog (sub-agent)", () => {
  it("lists only packages the parent offers, at live cost (dealer 8 + margin 2), ignoring the stale parent_price", async () => {
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body.is_dealer).toBe(true)
    expect(body.catalog).toHaveLength(1)
    expect(body.catalog[0]).toMatchObject({ id: "r1", package_id: "p1", parent_price: 10, selling_price: 11, profit_margin: 1 })
  })

  it("no margin-0 or shop_packages fallback: a parent with no active catalog rows offers nothing", async () => {
    h.state.tables.sub_agent_catalog = { data: [] }
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body.catalog).toEqual([])
  })

  it("a read failure of the parent's catalog is a 500, in the route's error style", async () => {
    h.state.tables.sub_agent_catalog = { data: null, error: { message: "boom" } }
    const { status, body } = await get()
    expect(status).toBe(500)
    expect(body.error).toBe("Failed to fetch catalog")
  })
})

describe("saving prices opens a closed storefront joiner's shop", () => {
  const open = openShop.openPricedShop as unknown as ReturnType<typeof vi.fn>
  const JOINER = { id: "sub-shop", parent_shop_id: "parent-shop", joined_via: "storefront", is_active: false, prices_set_at: null }
  const post = async () => {
    const res = await POST(new Request("http://x/api/shop/sub-agent-catalog", {
      method: "POST", headers: { Authorization: "Bearer t" },
      body: JSON.stringify({ package_id: "p1", sub_agent_profit_margin: 1 }),
    }) as any)
    return { status: res.status, body: await res.json() }
  }
  const put = async () => {
    const res = await PUT(new Request("http://x/api/shop/sub-agent-catalog", {
      method: "PUT", headers: { Authorization: "Bearer t" },
      body: JSON.stringify({ catalog_id: "r1", sub_agent_profit_margin: 1 }),
    }) as any)
    return { status: res.status, body: await res.json() }
  }
  beforeEach(() => {
    open.mockReset()
    h.state.tables.sub_agent_shop_packages = { data: { id: "r1" } }
  })

  it("POST by a closed joiner opens the shop and returns the links", async () => {
    h.state.tables.user_shops = { data: JOINER }
    open.mockResolvedValue({ status: "opened", ussdCode: "4321", subdomain: "kofi" })
    const { status, body } = await post()
    expect(status).toBe(200)
    expect(body).toMatchObject({ success: true, opened: true, ussdCode: "4321", subdomain: "kofi" })
    expect(open).toHaveBeenCalledWith(h.client, "sub-user")
  })

  it("PUT by a closed joiner opens the shop too", async () => {
    h.state.tables.user_shops = { data: JOINER }
    open.mockResolvedValue({ status: "opened", ussdCode: "4321", subdomain: "kofi" })
    const { body } = await put()
    expect(body).toMatchObject({ success: true, opened: true })
  })

  it("an invite sub-agent's save never calls open", async () => {
    h.state.tables.user_shops = { data: { ...JOINER, joined_via: null } }
    const { status, body } = await post()
    expect(status).toBe(200)
    expect(body.opened).toBeUndefined()
    expect(open).not.toHaveBeenCalled()
  })

  it("a main shop's save never calls open", async () => {
    h.state.userId = "parent-user"
    h.state.tables.user_shops = { data: { id: "parent-shop", parent_shop_id: null, joined_via: null, is_active: true, prices_set_at: null } }
    h.state.tables.sub_agent_catalog = { data: { id: "c1" } }
    const { status } = await post()
    expect(status).toBe(200)
    expect(open).not.toHaveBeenCalled()
  })

  it("an open failure still returns the save as successful", async () => {
    h.state.tables.user_shops = { data: JOINER }
    open.mockRejectedValue(new Error("db down"))
    const { status, body } = await post()
    expect(status).toBe(200)
    expect(body).toMatchObject({ success: true, opened: false })
  })
})

describe("GET /api/shop/sub-agent-catalog (parent)", () => {
  it("unchanged: the parent's own rows at their role price + wholesale margin", async () => {
    h.state.userId = "parent-user"
    h.state.tables.user_shops = { data: { id: "parent-shop", parent_shop_id: null } }
    h.state.tables.sub_agent_catalog = {
      data: [{ id: "c1", package_id: "p1", wholesale_margin: 2, is_active: false, package: PKG("p1") }],
    }
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body.catalog).toEqual([
      expect.objectContaining({ id: "c1", parent_price: 8, selling_price: 10, profit_margin: 2, is_active: false, is_dealer: true }),
    ])
  })
})
