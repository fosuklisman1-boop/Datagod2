import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  role: "dealer" as string | null,
  authed: true,
  failTable: null as string | null,
  rolePrices: [{ role_id: "r-dealer", package_id: "p1", price: 8 }] as any[],
}))

const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-sub", slug: "sub_agent", rank: null, is_system: true, archived_at: null },
  { id: "r-admin", slug: "admin", rank: null, is_system: true, archived_at: null },
]

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => (h.authed ? { data: { user: { id: "u1" } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => {
      const failed = h.failTable === t
      const result =
        failed ? { data: null, error: { message: "boom" } }
        : t === "users" ? { data: { role: h.role }, error: null }
        : t === "packages" ? { data: [
            { id: "p1", price: 10, dealer_price: 8 },
            { id: "p2", price: 5, dealer_price: null },
          ], error: null }
        : t === "roles" ? { data: ROLES, error: null }
        : { data: h.rolePrices, error: null }
      const c: any = { select: () => c, eq: () => c, in: () => c, order: () => c, limit: () => c, single: () => Promise.resolve(result), maybeSingle: () => Promise.resolve(result), then: (r: any, j: any) => Promise.resolve(result).then(r, j) }
      return c
    },
  }),
}))

import { GET } from "./route"
const req = (auth = true) => new NextRequest("http://x/api/shop/owner-base-prices", { headers: auth ? { Authorization: "Bearer t" } : {} })

describe("GET /api/shop/owner-base-prices", () => {
  beforeEach(() => {
    h.role = "dealer"; h.authed = true; h.failTable = null
    h.rolePrices = [{ role_id: "r-dealer", package_id: "p1", price: 8 }]
  })

  it("401 without a Bearer token or with a bad one", async () => {
    expect((await GET(req(false))).status).toBe(401)
    h.authed = false
    expect((await GET(req())).status).toBe(401)
  })
  it("a dealer owner gets dealer prices, public where there is no dealer price", async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect((await res.json()).base).toEqual({ p1: 8, p2: 5 })
  })
  it("an admin owner prices as a dealer", async () => {
    h.role = "admin"
    expect((await (await GET(req())).json()).base).toEqual({ p1: 8, p2: 5 })
  })
  it("a user owner gets the public price", async () => {
    h.role = "user"
    expect((await (await GET(req())).json()).base).toEqual({ p1: 10, p2: 5 })
  })
  it("a role price row for the user role is reflected", async () => {
    h.role = "user"
    h.rolePrices = [{ role_id: "r-user", package_id: "p1", price: 5.5 }]
    expect((await (await GET(req())).json()).base.p1).toBe(5.5)
  })
  it("a failed roles read is a 503 Failed to load prices, class name only in the log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.failTable = "roles"
    const res = await GET(req())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "Failed to load prices" })
    expect(JSON.stringify(spy.mock.calls)).not.toContain("boom")
    spy.mockRestore()
  })
})
