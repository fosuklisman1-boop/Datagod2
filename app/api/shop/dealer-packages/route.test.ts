import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  role: "dealer",
  mode: "custom" as string | null,
  prices: [{ package_id: "p1", price: 6 }] as any,
  pricesError: null as any,
  zeroDealer: false,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from: (t: string) => {
      const result =
        t === "users" ? { data: { role: h.role, pricing_mode: h.mode }, error: null }
        : t === "packages" ? { data: [
            { id: "p1", network: "MTN", size: "1", price: 10, dealer_price: h.zeroDealer ? 0 : 8, description: "", is_available: true },
            { id: "p2", network: "MTN", size: "2", price: 5, dealer_price: null, description: "", is_available: true },
          ], error: null }
        : { data: h.pricesError ? null : h.prices, error: h.pricesError }
      const c: any = { select: () => c, eq: () => c, order: () => c, limit: () => c, single: () => Promise.resolve(result), maybeSingle: () => Promise.resolve(result), then: (r: any, j: any) => Promise.resolve(result).then(r, j) }
      return c
    },
  }),
}))

import { GET } from "./route"
const req = () => new NextRequest("http://x/api/shop/dealer-packages", { headers: { Authorization: "Bearer t" } })

describe("GET /api/shop/dealer-packages", () => {
  beforeEach(() => { h.role = "dealer"; h.mode = "custom"; h.pricesError = null })

  it("shows the role (dealer) price even to a user on custom pricing: buy-stock is priced at role + margin", async () => {
    const body = await (await GET(req())).json()
    expect(body.packages[0]).toMatchObject({ price: 8, original_price: 10, dealer_price: 8, has_dealer_discount: true })
    expect(body.packages[1]).toMatchObject({ price: 5, original_price: 5, dealer_price: null })
  })
  it("admins count as dealers", async () => {
    h.mode = "role"; h.role = "admin"
    const body = await (await GET(req())).json()
    expect(body.packages.map((p: any) => p.price)).toEqual([8, 5])
  })
  it("does not read custom prices, so a failed custom-price read cannot block it", async () => {
    h.pricesError = { message: "x" }
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).packages.map((p: any) => p.price)).toEqual([8, 5])
  })
  it("a dealer_price of 0 falls back to price, never a free bundle", async () => {
    h.zeroDealer = true
    const body = await (await GET(req())).json()
    expect(body.packages[0].price).toBe(10)
    h.zeroDealer = false
  })
})
