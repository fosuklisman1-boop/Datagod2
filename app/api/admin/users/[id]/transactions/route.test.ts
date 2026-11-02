import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { createFakeDb, USER_ID, type FakeDb, type GateMode } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({ gate: "admin" as GateMode, fake: null as unknown as FakeDb }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))

import { GET as RAW_GET } from "./route"

const GET = async (qs = "", id = USER_ID) =>
  (await RAW_GET(new NextRequest(`http://x/api/admin/users/${id}/transactions${qs}`), { params: Promise.resolve({ id }) }))!
const TX = [{ id: "t1", type: "admin_credit", amount: 5, status: "completed", description: "x", reference_id: "r", source: "admin_operation", balance_before: 1, balance_after: 6, created_at: "2026-10-01" }]

const fake = (over: { txError?: boolean; wallet?: unknown } = {}) =>
  createFakeDb({
    tables: {
      transactions: () => over.txError ? { data: null, error: { message: "boom" } } : { data: TX, error: null, count: 41 },
      wallets: () => ({ data: over.wallet === undefined ? { balance: "6.00", total_credited: "10", total_spent: "4" } : over.wallet, error: null }),
    },
  })

beforeEach(() => {
  h.gate = "admin"
  h.fake = fake()
})

describe("GET /api/admin/users/[id]/transactions", () => {
  it("gates on verifyAdminAccess (403, 429)", async () => {
    h.gate = "forbidden"
    expect((await GET()).status).toBe(403)
    h.gate = "rate_limited"
    expect((await GET()).status).toBe(429)
    expect(h.fake.queries).toHaveLength(0)
  })

  it("400s on a bad uuid and on bad paging / type", async () => {
    expect((await GET("", "abc")).status).toBe(400)
    for (const qs of ["?page=0", "?pageSize=100", "?type=bogus"]) expect((await GET(qs)).status, qs).toBe(400)
    expect(h.fake.queries).toHaveLength(0)
  })

  it("returns one page newest first with an exact count and the wallet", async () => {
    const res = await GET("?page=3&pageSize=20")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      rows: TX, total: 41, page: 3, pageSize: 20,
      wallet: { balance: 6, totalCredited: 10, totalSpent: 4 },
    })
    const [q] = h.fake.ofTable("transactions")
    expect(q.columns).toBe("id, type, amount, status, description, reference_id, source, balance_before, balance_after, created_at")
    expect(q.count).toBe("exact")
    expect(q.filter("user_id")).toBe(USER_ID)
    expect(q.op("order")).toEqual(["order", "created_at", { ascending: false }])
    expect(q.op("range")).toEqual(["range", 40, 59])
    expect(h.fake.ofTable("wallets")[0].columns).toBe("balance, total_credited, total_spent")
  })

  it("filters admin adjustments by both admin types", async () => {
    await GET("?type=admin")
    expect(h.fake.ofTable("transactions")[0].op("in")).toEqual(["in", "type", ["admin_credit", "admin_debit"]])
  })

  it("wallet is null when the user has none; 500 on a query error", async () => {
    h.fake = fake({ wallet: null })
    expect((await (await GET()).json()).wallet).toBeNull()
    h.fake = fake({ txError: true })
    expect((await GET()).status).toBe(500)
  })
})
