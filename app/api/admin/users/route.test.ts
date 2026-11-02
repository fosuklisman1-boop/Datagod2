import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => {
  const state = {
    auth: "admin" as "admin" | "forbidden" | "ratelimited",
    rpcCalls: [] as Array<{ name: string; args: any }>,
    rpcResult: { data: null as any, error: null as any },
  }
  const fake = {
    rpc: (name: string, args: any) => {
      state.rpcCalls.push({ name, args })
      return Promise.resolve(state.rpcResult)
    },
    from: (t: string) => { throw new Error(`the list route must not query tables directly (${t})`) },
    auth: { admin: { listUsers: () => { throw new Error("the list route must not page auth users") } } },
  }
  return { state, fake }
})

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () =>
    h.state.auth === "forbidden"
      ? { isAdmin: false, errorResponse: new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }) }
      : h.state.auth === "ratelimited"
        // Same as today: verifyAdminAccess returns isAdmin true with a 429 errorResponse when rate
        // limited, and this route (like most admin routes) only checks isAdmin.
        ? { isAdmin: true, userId: "admin-1", errorResponse: new Response("{}", { status: 429 }) }
        : { isAdmin: true, userId: "admin-1" },
  ),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

import { GET as RAW_GET } from "./route"

// The route returns verifyAdminAccess's errorResponse as-is (typed possibly undefined).
const GET = async (r: NextRequest) => (await RAW_GET(r))!

const req = (qs = "") => new NextRequest(`http://x/api/admin/users${qs ? `?${qs}` : ""}`)
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, email: `${id}@x.com`, phone_number: "0244000000", first_name: null, last_name: null, role: "user",
  is_suspended: false, pricing_mode: "role", created_at: "2026-01-01T00:00:00+00:00", last_sign_in_at: null,
  shop_id: null, shop_name: null, shop_created_at: null, wallet_balance: 1, shop_balance: 0, customer_count: 0,
  sub_agent_count: 0, ...extra,
})

beforeEach(() => {
  h.state.auth = "admin"
  h.state.rpcCalls = []
  h.state.rpcResult = { data: { total: 0, rows: [] }, error: null }
})

describe("GET /api/admin/users", () => {
  it("returns the auth error response unchanged for non-admins, without calling the RPC", async () => {
    h.state.auth = "forbidden"
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it("keeps today's handling of a rate-limited admin (isAdmin gate only)", async () => {
    h.state.auth = "ratelimited"
    const res = await GET(req())
    expect(res.status).toBe(200)
  })

  it("calls admin_list_users once with defaults and returns {users,total,page,pageSize}", async () => {
    h.state.rpcResult = { data: { total: 123, rows: [row("a"), row("b", { shop_id: "s", shop_name: "S", shop_balance: 2, customer_count: 4 })] }, error: null }
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(h.state.rpcCalls).toEqual([{ name: "admin_list_users", args: {
      p_search: null, p_role: null, p_suspended: null, p_has_shop: null, p_pricing_mode: null,
      p_created_from: null, p_created_to: null, p_sort: "created_at", p_dir: "desc", p_limit: 50, p_offset: 0,
    } }])
    const body = await res.json()
    expect(body).toMatchObject({ total: 123, page: 1, pageSize: 50 })
    expect(body.users.map((u: any) => u.id)).toEqual(["a", "b"])
    expect(body.users[1]).toMatchObject({ phoneNumber: "0244000000", walletBalance: 1, shopBalance: 2, balance: 3, customerCount: 4,
      shop: { id: "s", user_id: "b", shop_name: "S" } })
  })

  it("passes filters, sort and paging through", async () => {
    await GET(req("q=%20Ama%20&role=dealer&suspended=true&hasShop=true&pricingMode=custom&from=2026-03-01&to=2026-03-31&sort=balance&dir=asc&page=2&pageSize=25"))
    expect(h.state.rpcCalls[0].args).toEqual({
      p_search: "Ama", p_role: "dealer", p_suspended: true, p_has_shop: true, p_pricing_mode: "custom",
      p_created_from: "2026-03-01T00:00:00Z", p_created_to: "2026-04-01T00:00:00Z", p_sort: "balance", p_dir: "asc",
      p_limit: 25, p_offset: 25,
    })
  })

  it("400s on invalid params without calling the RPC", async () => {
    const res = await GET(req("sort=password&role=root"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("Invalid query")
    expect(body.details).toHaveLength(2)
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it("500s when the RPC fails or returns garbage", async () => {
    h.state.rpcResult = { data: null, error: { message: "function admin_list_users does not exist" } }
    expect((await GET(req())).status).toBe(500)
    h.state.rpcResult = { data: { rows: "nope" }, error: null }
    expect((await GET(req())).status).toBe(500)
  })
})
