import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => {
  const state = {
    auth: "admin" as "admin" | "forbidden" | "ratelimited",
    rpcCalls: [] as Array<{ name: string; args: any }>,
    rpcResult: { data: null as any, error: null as any },
    signalsResult: { data: {} as any, error: null as any },
    blacklist: { data: [] as any[], error: null as any },
    blacklistQueries: [] as any[][],
  }
  const fake = {
    rpc: (name: string, args: any) => {
      state.rpcCalls.push({ name, args })
      return Promise.resolve(name === "admin_user_signals" ? state.signalsResult : state.rpcResult)
    },
    // Only the page's blacklist lookup (lib/blacklist.ts findBlacklistedPhones) reads a table.
    from: (t: string) => {
      if (t !== "blacklisted_phone_numbers") throw new Error(`the list route must not query tables directly (${t})`)
      const chain: any = {
        select: () => chain,
        in: (col: string, vals: string[]) => { state.blacklistQueries.push([col, vals]); return Promise.resolve(state.blacklist) },
      }
      return chain
    },
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
  h.state.signalsResult = { data: {}, error: null }
  h.state.blacklist = { data: [], error: null }
  h.state.blacklistQueries = []
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
    expect(h.state.rpcCalls[0]).toEqual({ name: "admin_list_users", args: {
      p_search: null, p_role: null, p_suspended: null, p_has_shop: null, p_pricing_mode: null,
      p_created_from: null, p_created_to: null, p_sort: "created_at", p_dir: "desc", p_limit: 50, p_offset: 0, p_tag: null,
    } })
    // then the page's signals, for exactly the page's ids, with the windows from risk-signals.ts
    expect(h.state.rpcCalls[1]).toEqual({ name: "admin_user_signals", args: {
      p_user_ids: ["a", "b"], p_failed_hours: 24, p_refund_hours: 168, p_credit_hours: 24,
    } })
    expect(h.state.rpcCalls).toHaveLength(2)
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
      p_limit: 25, p_offset: 25, p_tag: null,
    })
  })

  it("passes the tag filter and returns each row's tags", async () => {
    h.state.rpcResult = { data: { total: 1, rows: [row("a", { tags: ["vip"] })] }, error: null }
    const res = await GET(req("tag=VIP"))
    expect(h.state.rpcCalls[0].args.p_tag).toBe("vip")
    expect((await res.json()).users[0].tags).toEqual(["vip"])
  })

  it("attaches signals for the page: last order, phone verified / blacklisted, flags with reasons", async () => {
    const now = new Date().toISOString()
    h.state.rpcResult = { data: { total: 2, rows: [row("a", { phone_number: "0244111222" }), row("b", { phone_number: "0201234567" })] }, error: null }
    h.state.signalsResult = { data: {
      a: { last_order_at: "2026-10-30T10:00:00+00:00", failed_orders: 6, refunds: 0, admin_credits: 0, admin_credit_amount: 0,
           created_at: "2025-01-01T00:00:00+00:00", wallet_balance: 1, phone_number: "0244111222", phone_verified: true, same_phone_accounts: 1 },
      b: { last_order_at: null, failed_orders: 0, refunds: 0, admin_credits: 0, admin_credit_amount: 0,
           created_at: now, wallet_balance: 900, phone_number: "0201234567", phone_verified: false, same_phone_accounts: 1 },
    }, error: null }
    h.state.blacklist = { data: [{ phone_number: "201234567" }], error: null }
    const body = await (await GET(req())).json()
    const [a, b] = body.users
    expect(a.signals).toMatchObject({ lastOrderAt: "2026-10-30T10:00:00+00:00", phoneVerified: true, phoneBlacklisted: false })
    expect(a.signals.flags.map((f: any) => f.code)).toEqual(["failed_orders"])
    expect(a.signals.flags[0].reason).toMatch(/6 failed orders in the last 24 hours/)
    expect(b.signals).toMatchObject({ lastOrderAt: null, phoneVerified: false, phoneBlacklisted: true })
    expect(b.signals.flags.map((f: any) => f.code)).toEqual(["new_account_high_balance"])
    // one blacklist query for the whole page, both stored forms of each number
    expect(h.state.blacklistQueries).toEqual([["phone_number", ["244111222", "0244111222", "201234567", "0201234567"]]])
    expect(body.signalsUnavailable).toBeUndefined()
  })

  it("still returns the page when the signals RPC fails (signals null, signalsUnavailable)", async () => {
    h.state.rpcResult = { data: { total: 1, rows: [row("a")] }, error: null }
    h.state.signalsResult = { data: null, error: { message: "function admin_user_signals does not exist" } }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.users[0].signals).toBeNull()
    expect(body.signalsUnavailable).toBe(true)
  })

  it("does not ask for signals when the page is empty", async () => {
    await GET(req())
    expect(h.state.rpcCalls.map((c) => c.name)).toEqual(["admin_list_users"])
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
