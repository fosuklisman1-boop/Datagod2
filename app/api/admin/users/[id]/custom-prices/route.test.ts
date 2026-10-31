import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => {
  const state = {
    isAdmin: true,
    adminId: "admin-1" as string | undefined,
    user: { id: "u1", role: "dealer", pricing_mode: "custom" } as any,
    packages: [{ id: "p1", network: "MTN", size: "1", price: 10, dealer_price: 8, is_available: true }],
    prices: [{ package_id: "p1", price: 6 }],
    stalePackages: [{ id: "p2", network: "AT", size: "2", price: 20, dealer_price: null, is_available: false }] as any[],
    errors: {} as Record<string, any>,
    rateLimited: false,
    calls: [] as any[],
    rpcCalls: [] as any[],
    rpcError: null as any,
  }
  const chain = (table: string, result: any) => {
    let res = result
    const c: any = {
      select: () => c,
      eq: (col: string, v: any) => (state.calls.push({ table, op: "eq", col, v }), c),
      in: (col: string, v: any) => {
        state.calls.push({ table, op: "in", col, v })
        if (table === "packages") res = state.errors.stale ? { data: null, error: state.errors.stale } : { data: state.stalePackages, error: null }
        return c
      },
      order: () => c,
      maybeSingle: () => Promise.resolve(res),
      then: (r: any, j: any) => Promise.resolve(res).then(r, j),
    }
    return c
  }
  const fake = {
    from: (t: string) =>
      t === "users" ? chain(t, state.errors.users ? { data: null, error: state.errors.users } : { data: state.user, error: null })
      : t === "packages" ? chain(t, state.errors.packages ? { data: null, error: state.errors.packages } : { data: state.packages, error: null })
      : t === "user_package_prices" ? chain(t, state.errors.prices ? { data: null, error: state.errors.prices } : { data: state.prices, error: null })
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
    h.state.rateLimited ? { isAdmin: true, userId: h.state.adminId, errorResponse: new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }) }
    : h.state.isAdmin ? { isAdmin: true, userId: h.state.adminId } : { isAdmin: false, errorResponse: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) }
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
  h.state.errors = {}
  h.state.rateLimited = false
  h.state.calls = []
  h.state.prices = [{ package_id: "p1", price: 6 }]
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
      packages: [
        { id: "p1", network: "MTN", size: "1", price: 10, dealer_price: 8, role_price: 8, custom_price: 6, is_available: true },
        { id: "p2", network: "AT", size: "2", price: 20, dealer_price: null, role_price: 20, custom_price: null, is_available: false },
      ],
    })
  })
  it("filters by the user id, available packages, and the custom-priced ids", async () => {
    await GET(new NextRequest("http://x"), ctx)
    const c = h.state.calls
    expect(c).toContainEqual({ table: "users", op: "eq", col: "id", v: U1 })
    expect(c).toContainEqual({ table: "user_package_prices", op: "eq", col: "user_id", v: U1 })
    expect(c).toContainEqual({ table: "packages", op: "eq", col: "is_available", v: true })
    expect(c).toContainEqual({ table: "packages", op: "in", col: "id", v: ["p1"] })
  })
  it("skips the stale-package query when the user has no custom prices", async () => {
    h.state.prices = []
    const body = await (await GET(new NextRequest("http://x"), ctx)).json()
    expect(h.state.calls.some((x: any) => x.op === "in")).toBe(false)
    expect(body.packages).toHaveLength(1)
    expect(body.packages[0].custom_price).toBeNull()
  })
  it("returns the unavailable package that still has a custom price", async () => {
    h.state.stalePackages = [{ id: "p1", network: "MTN", size: "1", price: 10, dealer_price: 8, is_available: false }]
    h.state.packages = []
    const body = await (await GET(new NextRequest("http://x"), ctx)).json()
    expect(body.packages).toEqual([{ id: "p1", network: "MTN", size: "1", price: 10, dealer_price: 8, role_price: 8, custom_price: 6, is_available: false }])
  })
  it.each(["users", "prices", "packages", "stale"])("500 when the %s query fails", async (k) => {
    h.state.errors = { [k]: { message: "boom" } }
    expect((await GET(new NextRequest("http://x"), ctx)).status).toBe(500)
  })
  it("returns the rate-limit response", async () => {
    h.state.rateLimited = true
    expect((await GET(new NextRequest("http://x"), ctx)).status).toBe(429)
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
  it("returns the rate-limit response and does not call the RPC", async () => {
    h.state.rateLimited = true
    expect((await PUT(put({ pricing_mode: "role" }), ctx)).status).toBe(429)
    expect(h.state.rpcCalls).toEqual([])
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
  it("maps an RPC BAD_INPUT to 400 with its detail, 'user not found' to 404, other errors to 500", async () => {
    h.state.rpcError = { code: "P0001", message: "BAD_INPUT", details: "user not found" }
    expect((await PUT(put({ pricing_mode: "custom" }), ctx)).status).toBe(404)
    h.state.rpcError = { code: "P0001", message: "BAD_INPUT", details: "unknown package" }
    const bad = await PUT(put({ pricing_mode: "custom" }), ctx)
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe("unknown package")
    h.state.rpcError = { message: "BAD_INPUT", details: "x" } // no P0001 code: not trusted as BAD_INPUT
    expect((await PUT(put({ pricing_mode: "custom" }), ctx)).status).toBe(500)
    h.state.rpcError = { message: "connection reset by peer" }
    const res = await PUT(put({ pricing_mode: "custom" }), ctx)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("connection reset")
  })
})
