import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  parentRole: "dealer" as string,
  parentShopId: "parent-shop" as string | null,
  failTable: null as string | null,
  rolePrices: [{ role_id: "r-dealer", package_id: "p1", price: 8 }] as any[],
}))

const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-sub", slug: "sub_agent", rank: null, is_system: true, archived_at: null },
  { id: "r-admin", slug: "admin", rank: null, is_system: true, archived_at: null },
]
const PKG = (id: string, dealer: number | null) => ({ id, network: "MTN", size: "1", price: id === "p1" ? 10 : 5, dealer_price: dealer, description: "", is_available: true })

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "sub-user" } }, error: null }) },
    from: (t: string) => {
      const failed = h.failTable === t
      // user_shops is read twice (own shop, then parent's owner); the fake returns one row for both.
      const result =
        failed ? { data: null, error: { message: "boom" } }
        : t === "user_shops" ? { data: { id: "sub-shop", parent_shop_id: h.parentShopId, user_id: "parent-user", tier_level: 1 }, error: null }
        : t === "users" ? { data: { role: h.parentRole, pricing_mode: null }, error: null }
        : t === "roles" ? { data: ROLES, error: null }
        : t === "role_package_prices" ? { data: h.rolePrices, error: null }
        : t === "sub_agent_catalog" ? { data: [
            { id: "c1", package_id: "p1", wholesale_margin: 2, is_active: true, package: PKG("p1", 8) },
            { id: "c2", package_id: "p2", wholesale_margin: 1, is_active: true, package: PKG("p2", null) },
          ], error: null }
        : { data: null, error: null }
      const c: any = { select: () => c, eq: () => c, in: () => c, order: () => c, limit: () => c, single: () => Promise.resolve(result), maybeSingle: () => Promise.resolve(result), then: (r: any, j: any) => Promise.resolve(result).then(r, j) }
      return c
    },
  }),
}))

import { GET } from "./route"
const get = async () => {
  const res = await GET(new NextRequest("http://x/api/shop/parent-packages", { headers: { Authorization: "Bearer t" } }))
  return { status: res.status, body: await res.json() }
}

describe("GET /api/shop/parent-packages", () => {
  beforeEach(() => {
    h.parentRole = "dealer"; h.parentShopId = "parent-shop"; h.failTable = null
    h.rolePrices = [{ role_id: "r-dealer", package_id: "p1", price: 8 }]
  })

  it("a dealer parent: base is the dealer price (public where none), parent_price = base + margin", async () => {
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body.packages.map((p: any) => [p.package_id, p.base_price, p.parent_price, p.profit_margin])).toEqual([
      ["p1", 8, 10, 2],
      ["p2", 5, 6, 1],
    ])
    expect(body.packages[0]).toMatchObject({ id: "c1", _original_admin_price: 8, _parent_selling_price: 10 })
  })
  it("an admin parent prices as a dealer", async () => {
    h.parentRole = "admin"
    const { body } = await get()
    expect(body.packages[0].base_price).toBe(8)
  })
  it("a user parent prices at the public price", async () => {
    h.parentRole = "user"
    const { body } = await get()
    expect(body.packages.map((p: any) => p.base_price)).toEqual([10, 5])
  })
  it("a role price row for the user role is reflected", async () => {
    h.parentRole = "user"
    h.rolePrices = [{ role_id: "r-user", package_id: "p1", price: 5.5 }]
    const { body } = await get()
    expect(body.packages[0]).toMatchObject({ base_price: 5.5, parent_price: 7.5 })
  })
  it("not a sub-agent: empty list", async () => {
    h.parentShopId = null
    const { body } = await get()
    expect(body).toEqual({ is_sub_agent: false, packages: [] })
  })
  it("a failed roles read is a 503, class name only in the log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.failTable = "roles"
    const { status, body } = await get()
    expect(status).toBe(503)
    expect(body.error).toBe("Failed to load prices")
    expect(JSON.stringify(spy.mock.calls)).not.toContain("boom")
    spy.mockRestore()
  })
})
