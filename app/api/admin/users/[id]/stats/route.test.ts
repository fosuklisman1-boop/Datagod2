import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => {
  const state = {
    isAdmin: true,
    calls: [] as Array<{ name: string; args: any }>,
    results: {} as Record<string, { data: any; error: any }>,
  }
  const fake = {
    rpc: (name: string, args: any) => {
      state.calls.push({ name, args })
      return Promise.resolve(state.results[name] ?? { data: null, error: { code: "PGRST202", message: "not found" } })
    },
    from: (t: string) => { throw new Error(`stats route must not read tables directly (${t})`) },
  }
  return { state, fake }
})

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () =>
    h.state.isAdmin ? { isAdmin: true, userId: "admin-1" }
      : { isAdmin: false, errorResponse: new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }) },
  ),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

import { GET as RAW_GET } from "./route"

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const GET = async (id = U) => (await RAW_GET(new NextRequest(`http://x/api/admin/users/${id}/stats`), { params: Promise.resolve({ id }) }))!
const STATS = {
  userId: U,
  wallet: { balance: 10, totalTopUps: 30, totalSpent: 15, transactionCount: 6 },
  orders: { total: 5, completed: 2, failed: 1, pending: 2 },
  shop: null,
  withdrawals: { totalWithdrawn: 0, pendingCount: 0, completedCount: 0, history: [] },
}

beforeEach(() => {
  h.state.isAdmin = true
  h.state.calls = []
  h.state.results = {}
})

describe("GET /api/admin/users/[id]/stats", () => {
  it("returns the auth error for non-admins", async () => {
    h.state.isAdmin = false
    expect((await GET()).status).toBe(403)
    expect(h.state.calls).toHaveLength(0)
  })

  it("400s on an id that is not a uuid, without calling the RPC", async () => {
    for (const bad of ["not-a-uuid", "", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa", "1 or 1=1"]) {
      const res = await GET(bad)
      expect(res.status, bad).toBe(400)
    }
    expect(h.state.calls).toHaveLength(0)
  })

  it("serves admin_user_stats with the same shape as before", async () => {
    h.state.results.admin_user_stats = { data: STATS, error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(STATS)
    expect(h.state.calls).toEqual([{ name: "admin_user_stats", args: { p_user_id: U } }])
  })

  it("falls back to get_user_financial_summary only when admin_user_stats is not deployed", async () => {
    h.state.results.get_user_financial_summary = { data: STATS, error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(h.state.calls.map((c) => c.name)).toEqual(["admin_user_stats", "get_user_financial_summary"])
  })

  it("500s on other RPC errors without falling back", async () => {
    h.state.results.admin_user_stats = { data: null, error: { code: "57014", message: "statement timeout" } }
    expect((await GET()).status).toBe(500)
    expect(h.state.calls).toHaveLength(1)
  })

  it("404s when the RPC returns nothing", async () => {
    h.state.results.admin_user_stats = { data: null, error: null }
    expect((await GET()).status).toBe(404)
  })
})
