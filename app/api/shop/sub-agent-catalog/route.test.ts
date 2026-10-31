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
        select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b,
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

import { GET } from "./route"

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
