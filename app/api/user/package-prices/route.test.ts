import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  user: { id: "u1" } as any,
  role: "dealer",
  mode: "custom",
  packages: [{ id: "p1", price: 10, dealer_price: 8 }, { id: "p2", price: 5, dealer_price: null }],
  prices: [{ package_id: "p1", price: 6 }] as any,
  pricesError: null as any,
  userRow: true,
  userError: null as any,
  pkgError: null as any,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: h.user ? null : { message: "no" } }) },
    from: (t: string) => {
      const result =
        t === "users" ? { data: h.userRow ? { role: h.role, pricing_mode: h.mode } : null, error: h.userError }
        : t === "packages" ? { data: h.pkgError ? null : h.packages, error: h.pkgError }
        : { data: h.pricesError ? null : h.prices, error: h.pricesError }
      const c: any = { select: () => c, eq: () => c, limit: () => c, single: () => Promise.resolve(result), maybeSingle: () => Promise.resolve(result), then: (r: any, j: any) => Promise.resolve(result).then(r, j) }
      return c
    },
  }),
}))

import { GET } from "./route"
const req = () => new NextRequest("http://x/api/user/package-prices", { headers: { Authorization: "Bearer t" } })

describe("GET /api/user/package-prices", () => {
  beforeEach(() => {
    h.user = { id: "u1" }
    h.role = "dealer"
    h.mode = "custom"
    h.pricesError = null
    h.userRow = true
    h.userError = null
    h.pkgError = null
  })
  it("returns the caller's resolved price per package", async () => {
    const res = await GET(req())
    expect(await res.json()).toEqual({ pricing_mode: "custom", prices: { p1: 6, p2: 5 }, custom_ids: ["p1"] })
  })
  it("role mode gives the dealer price", async () => {
    h.mode = "role"
    const res = await GET(req())
    expect(await res.json()).toEqual({ pricing_mode: "role", prices: { p1: 8, p2: 5 }, custom_ids: [] })
  })
  it("401 without a valid session", async () => {
    h.user = null
    expect((await GET(req())).status).toBe(401)
  })
  it("503 when custom prices cannot be read", async () => {
    h.pricesError = { message: "boom" }
    expect((await GET(req())).status).toBe(503)
  })
  it("admin gets the plain price, not the dealer price", async () => {
    h.mode = "role"; h.role = "admin"
    expect((await (await GET(req())).json()).prices).toEqual({ p1: 10, p2: 5 })
  })
  it("500 when the packages query errors", async () => {
    h.pkgError = { message: "x" }
    expect((await GET(req())).status).toBe(500)
  })
  it("503 when the users query errors", async () => {
    h.userError = { message: "x" }
    expect((await GET(req())).status).toBe(503)
  })
  it("404 when there is no users row", async () => {
    h.userRow = false
    expect((await GET(req())).status).toBe(404)
  })
})
