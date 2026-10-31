import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  user: { id: "u1" } as any,
  role: "dealer",
  mode: "custom",
  packages: [{ id: "p1", price: 10, dealer_price: 8 }, { id: "p2", price: 5, dealer_price: null }],
  prices: [{ package_id: "p1", price: 6 }] as any,
  pricesError: null as any,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: h.user ? null : { message: "no" } }) },
    from: (t: string) => {
      const result =
        t === "users" ? { data: { role: h.role, pricing_mode: h.mode }, error: null }
        : t === "packages" ? { data: h.packages, error: null }
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
  })
  it("returns the caller's resolved price per package", async () => {
    const res = await GET(req())
    expect(await res.json()).toEqual({ pricing_mode: "custom", prices: { p1: 6, p2: 5 } })
  })
  it("role mode gives the dealer price", async () => {
    h.mode = "role"
    const res = await GET(req())
    expect(await res.json()).toEqual({ pricing_mode: "role", prices: { p1: 8, p2: 5 } })
  })
  it("401 without a valid session", async () => {
    h.user = null
    expect((await GET(req())).status).toBe(401)
  })
  it("503 when custom prices cannot be read", async () => {
    h.pricesError = { message: "boom" }
    expect((await GET(req())).status).toBe(503)
  })
})
