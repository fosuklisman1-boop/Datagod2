import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => {
  const state = {
    isAdmin: true,
    adminId: "admin-1" as string | undefined,
    user: { id: "u1", role: "dealer", pricing_mode: "custom" } as any,
    packages: [{ id: "p1", network: "MTN", size: "1", price: 10, dealer_price: 8, is_available: true }],
    prices: [{ package_id: "p1", price: 6 }],
    rpcCalls: [] as any[],
    rpcError: null as any,
  }
  const chain = (result: any) => {
    const c: any = { select: () => c, eq: () => c, order: () => c, maybeSingle: () => Promise.resolve(result), then: (r: any, j: any) => Promise.resolve(result).then(r, j) }
    return c
  }
  const fake = {
    from: (t: string) =>
      t === "users" ? chain({ data: state.user, error: null })
      : t === "packages" ? chain({ data: state.packages, error: null })
      : t === "user_package_prices" ? chain({ data: state.prices, error: null })
      : (() => { throw new Error(`unexpected table ${t}`) })(),
    rpc: (name: string, args: any) => {
      state.rpcCalls.push({ name, args })
      return Promise.resolve(state.rpcError ? { data: null, error: state.rpcError } : { data: { changed: 1 }, error: null })
    },
  }
  return { state, fake }
})

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () =>
    h.state.isAdmin ? { isAdmin: true, userId: h.state.adminId } : { isAdmin: false, errorResponse: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) }
  ),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

import { GET, PUT } from "./route"

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ctx = { params: Promise.resolve({ id: U1 }) }
const badCtx = { params: Promise.resolve({ id: "not-a-uuid" }) }
const put = (body: unknown) => new NextRequest(`http://x/api/admin/users/${U1}/custom-prices`, { method: "PUT", body: JSON.stringify(body) })
const P1 = "11111111-1111-1111-1111-111111111111"

beforeEach(() => {
  h.state.isAdmin = true
  h.state.adminId = "admin-1"
  h.state.user = { id: U1, role: "dealer", pricing_mode: "custom" }
  h.state.rpcCalls = []
  h.state.rpcError = null
})

describe("GET custom-prices", () => {
  it("403 for non-admins", async () => {
    h.state.isAdmin = false
    expect((await GET(new NextRequest("http://x"), ctx)).status).toBe(403)
  })
  it("400 for a malformed user id", async () => {
    expect((await GET(new NextRequest("http://x"), badCtx)).status).toBe(400)
  })
  it("returns mode, role and packages with custom prices", async () => {
    const res = await GET(new NextRequest("http://x"), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      user: { id: U1, role: "dealer", pricing_mode: "custom" },
      packages: [{ id: "p1", network: "MTN", size: "1", price: 10, dealer_price: 8, role_price: 8, custom_price: 6 }],
    })
  })
  it("404 for an unknown user", async () => {
    h.state.user = null
    expect((await GET(new NextRequest("http://x"), ctx)).status).toBe(404)
  })
})

describe("PUT custom-prices", () => {
  it("403 for non-admins", async () => {
    h.state.isAdmin = false
    expect((await PUT(put({ pricing_mode: "role" }), ctx)).status).toBe(403)
  })
  it("403 when admin access has no real user id (CRON_SECRET bypass)", async () => {
    h.state.adminId = undefined
    expect((await PUT(put({ pricing_mode: "role" }), ctx)).status).toBe(403)
    expect(h.state.rpcCalls).toEqual([])
  })
  it("400 for a malformed user id and no RPC call", async () => {
    expect((await PUT(put({ pricing_mode: "role" }), badCtx)).status).toBe(400)
    expect(h.state.rpcCalls).toEqual([])
  })
  it("400 on invalid JSON", async () => {
    const req = new NextRequest("http://x", { method: "PUT", body: "{nope" })
    expect((await PUT(req, ctx)).status).toBe(400)
  })
  it("400 with per-row errors and no RPC call on a bad price", async () => {
    const res = await PUT(put({ prices: [{ package_id: P1, price: -1 }] }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).errors).toEqual({ "0": "Price must be more than 0" })
    expect(h.state.rpcCalls).toEqual([])
  })
  it("calls the RPC once with the admin, user, mode and prices", async () => {
    const res = await PUT(put({ pricing_mode: "custom", prices: [{ package_id: P1, price: 5 }] }), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, changed: 1 })
    expect(h.state.rpcCalls).toEqual([{ name: "set_user_custom_prices", args: { p_admin: "admin-1", p_user: U1, p_mode: "custom", p_prices: [{ package_id: P1, price: 5 }] } }])
  })
  it("maps an RPC BAD_INPUT to 400 with its detail and other errors to 500", async () => {
    h.state.rpcError = { message: "BAD_INPUT", details: "unknown package" }
    const bad = await PUT(put({ pricing_mode: "custom" }), ctx)
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe("unknown package")
    h.state.rpcError = { message: "connection reset" }
    expect((await PUT(put({ pricing_mode: "custom" }), ctx)).status).toBe(500)
  })
})
