import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { createFakeDb, USER_ID, type FakeDb, type FakeQuery, type GateMode } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({ gate: "admin" as GateMode, fake: null as unknown as FakeDb }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))

import { GET as RAW_GET } from "./route"

const GET = async (qs = "", id = USER_ID) =>
  (await RAW_GET(new NextRequest(`http://x/api/admin/users/${id}/shop${qs}`), { params: Promise.resolve({ id }) }))!

const SHOP = { id: "shop-1", shop_name: "Alpha", shop_slug: "alpha", is_active: true, parent_shop_id: "shop-0", created_at: "2026-01-01" }
const fake = (shop: unknown = SHOP) =>
  createFakeDb({
    tables: {
      user_shops: (q: FakeQuery) => {
        if (q.filter("user_id")) return { data: shop, error: null }
        if (q.filter("parent_shop_id")) return { data: [{ id: "shop-2", user_id: "u2", shop_name: "Sub", shop_slug: "sub", created_at: "2026-02-01" }], error: null, count: 21 }
        if (q.filter("id")) return { data: { id: "shop-0", shop_name: "Parent", shop_slug: "parent", user_id: "u0" }, error: null }
        return { data: null, error: { message: "unexpected" } }
      },
      shop_available_balance: () => ({ data: { available_balance: "7.5", total_profit: "20", withdrawn_profit: "10", pending_profit: "2.5", credited_profit: "7.5" }, error: null }),
      shop_customers: () => ({ data: null, error: null, count: 4 }),
      users: () => ({ data: [{ id: "u2", email: "sub@x.com" }], error: null }),
      withdrawal_requests: () => ({ data: [{ id: "w1", amount: 10, net_amount: 9, status: "completed" }], error: null, count: 1 }),
    },
  })

beforeEach(() => {
  h.gate = "admin"
  h.fake = fake()
})

describe("GET /api/admin/users/[id]/shop", () => {
  it("gates on verifyAdminAccess", async () => {
    h.gate = "forbidden"
    expect((await GET()).status).toBe(403)
    h.gate = "rate_limited"
    expect((await GET()).status).toBe(429)
    expect(h.fake.queries).toHaveLength(0)
  })

  it("400s on a bad uuid, part or paging", async () => {
    expect((await GET("", "zzz")).status).toBe(400)
    for (const qs of ["?part=everything", "?page=2", "?part=withdrawals&page=0", "?part=sub_agents&pageSize=99"]) {
      expect((await GET(qs)).status, qs).toBe(400)
    }
    expect(h.fake.queries).toHaveLength(0)
  })

  it("returns the shop, balance, customer count, parent, and page 1 of sub-agents and withdrawals", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.shop).toEqual({
      id: "shop-1", shop_name: "Alpha", shop_slug: "alpha", is_active: true, created_at: "2026-01-01", customers: 4,
      balance: { available: 7.5, totalProfit: 20, withdrawn: 10, pending: 2.5, credited: 7.5 },
    })
    expect(body.parent).toEqual({ id: "shop-0", shop_name: "Parent", shop_slug: "parent", user_id: "u0" })
    expect(body.subAgents).toEqual({
      rows: [{ shop_id: "shop-2", user_id: "u2", email: "sub@x.com", shop_name: "Sub", shop_slug: "sub", created_at: "2026-02-01" }],
      total: 21, page: 1, pageSize: 20,
    })
    expect(body.withdrawals.total).toBe(1)
    // Customers are counted, not loaded.
    const [c] = h.fake.ofTable("shop_customers")
    expect(c.head).toBe(true)
    expect(c.count).toBe("exact")
    const subs = h.fake.ofTable("user_shops").find((q) => q.filter("parent_shop_id"))!
    expect(subs.op("range")).toEqual(["range", 0, 19])
    expect(h.fake.ofTable("withdrawal_requests")[0].filter("user_id")).toBe(USER_ID)
  })

  it("part=sub_agents / withdrawals returns just that list at the page asked", async () => {
    const subs = await (await GET("?part=sub_agents&page=2&pageSize=10")).json()
    expect(Object.keys(subs)).toEqual(["subAgents"])
    expect(subs.subAgents.page).toBe(2)
    expect(h.fake.ofTable("user_shops").find((q) => q.filter("parent_shop_id"))!.op("range")).toEqual(["range", 10, 19])
    expect(h.fake.ofTable("withdrawal_requests")).toHaveLength(0)

    h.fake = fake()
    const wds = await (await GET("?part=withdrawals&page=3")).json()
    expect(Object.keys(wds)).toEqual(["withdrawals"])
    expect(h.fake.ofTable("withdrawal_requests")[0].op("range")).toEqual(["range", 40, 59])
  })

  it("a user without a shop gets shop null and no sub-agents, but still their withdrawals", async () => {
    h.fake = fake(null)
    const body = await (await GET()).json()
    expect(body.shop).toBeNull()
    expect(body.parent).toBeNull()
    expect(body.subAgents).toEqual({ rows: [], total: 0, page: 1, pageSize: 20 })
    expect(body.withdrawals.total).toBe(1)
    expect(h.fake.ofTable("shop_customers")).toHaveLength(0)
  })

  it("500s when a query fails", async () => {
    h.fake = createFakeDb({ tables: { user_shops: () => ({ data: null, error: { message: "boom" } }) } })
    expect((await GET()).status).toBe(500)
  })
})
