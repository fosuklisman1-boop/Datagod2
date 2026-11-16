import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { encodeExportCursor, decodeExportCursor } from "@/lib/admin-users/export-params"

const h = vi.hoisted(() => {
  const state = {
    isAdmin: true,
    rpcCalls: [] as Array<{ name: string; args: any }>,
    rpcResult: { data: null as any, error: null as any },
  }
  const fake = {
    rpc: (name: string, args: any) => {
      state.rpcCalls.push({ name, args })
      return Promise.resolve(state.rpcResult)
    },
    from: (t: string) => { throw new Error(`export must not read tables directly (${t})`) },
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

const GET = async (qs = "") => (await RAW_GET(new NextRequest(`http://x/api/admin/users/export${qs ? `?${qs}` : ""}`)))!
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const row = (id: string) => ({
  id, email: `${id}@x.com`, phone_number: null, first_name: null, last_name: null, role: "user", is_suspended: false,
  pricing_mode: "role", created_at: "2026-01-01T00:00:00+00:00", last_sign_in_at: null, shop_id: null, shop_name: null,
  shop_created_at: null, wallet_balance: 2, shop_balance: 0, customer_count: 0, sub_agent_count: 0,
})

beforeEach(() => {
  h.state.isAdmin = true
  h.state.rpcCalls = []
  h.state.rpcResult = { data: { rows: [], next_cursor: null }, error: null }
})

describe("GET /api/admin/users/export", () => {
  it("returns the auth error for non-admins without calling the RPC", async () => {
    h.state.isAdmin = false
    expect((await GET()).status).toBe(403)
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it("first chunk: no cursor, 5000 rows, filters passed through", async () => {
    h.state.rpcResult = { data: { rows: [row("a")], next_cursor: { created_at: "2026-01-01T00:00:00.5+00:00", id: ID } }, error: null }
    const res = await GET("role=dealer&hasShop=true")
    expect(res.status).toBe(200)
    expect(h.state.rpcCalls).toEqual([{ name: "admin_export_users", args: {
      p_search: null, p_role: "dealer", p_suspended: null, p_has_shop: true, p_pricing_mode: null,
      p_created_from: null, p_created_to: null, p_after_created_at: null, p_after_id: null, p_limit: 5000, p_tag: null,
    } }])
    const body = await res.json()
    expect(body.users.map((u: any) => u.id)).toEqual(["a"])
    expect(body.users[0]).toMatchObject({ walletBalance: 2, phoneNumber: "", shop: null })
    expect(decodeExportCursor(body.nextCursor)).toEqual({ createdAt: "2026-01-01T00:00:00.5+00:00", id: ID })
  })

  it("next chunk: passes the decoded cursor; last chunk returns nextCursor null", async () => {
    const cursor = encodeExportCursor({ createdAt: "2026-01-01T00:00:00+00:00", id: ID })
    const res = await GET(`cursor=${cursor}&limit=2000`)
    expect(h.state.rpcCalls[0].args).toMatchObject({ p_after_created_at: "2026-01-01T00:00:00+00:00", p_after_id: ID, p_limit: 2000 })
    expect(await res.json()).toEqual({ users: [], nextCursor: null })
  })

  it("400s on a bad cursor or filter without calling the RPC", async () => {
    expect((await GET("cursor=nope")).status).toBe(400)
    expect((await GET("pricingMode=free")).status).toBe(400)
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it("500s when the RPC fails or returns garbage", async () => {
    h.state.rpcResult = { data: null, error: { message: "boom" } }
    expect((await GET()).status).toBe(500)
    h.state.rpcResult = { data: { rows: "x" }, error: null }
    expect((await GET()).status).toBe(500)
  })
})
