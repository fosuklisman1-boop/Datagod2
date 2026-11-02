import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { createFakeDb, USER_ID, type FakeDb, type GateMode } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({ gate: "admin" as GateMode, fake: null as unknown as FakeDb }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))

import { GET as RAW_GET } from "./route"

const GET = async (id = USER_ID) => (await RAW_GET(new NextRequest(`http://x/api/admin/users/${id}/signals`), { params: Promise.resolve({ id }) }))!

beforeEach(() => {
  h.gate = "admin"
  h.fake = createFakeDb({
    rpc: () => ({ data: { [USER_ID]: { last_order_at: null, failed_orders: 0, refunds: 4, phone_number: "0244111222", phone_verified: false,
      created_at: "2025-01-01T00:00:00Z", wallet_balance: 0, admin_credits: 0, admin_credit_amount: 0, same_phone_accounts: 1 } }, error: null }),
    tables: { blacklisted_phone_numbers: () => ({ data: [{ phone_number: "0244111222" }], error: null }) },
  })
})

describe("GET /api/admin/users/[id]/signals", () => {
  it("returns the user's signals, checking the phone the RPC returned against the blacklist", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const { signals } = await res.json()
    expect(signals).toMatchObject({ lastOrderAt: null, phoneVerified: false, phoneBlacklisted: true, flags: [{ code: "refunds" }] })
    expect(h.fake.rpcCalls).toEqual([{ name: "admin_user_signals", args: { p_user_ids: [USER_ID], p_failed_hours: 24, p_refund_hours: 168, p_credit_hours: 24 } }])
    expect(h.fake.ofTable("blacklisted_phone_numbers")[0].op("in")).toEqual(["in", "phone_number", ["244111222", "0244111222"]])
  })

  it("gate and id", async () => {
    h.gate = "forbidden"
    expect((await GET()).status).toBe(403)
    h.gate = "admin"
    expect((await GET("nope")).status).toBe(400)
  })

  it("500s when the RPC fails", async () => {
    h.fake = createFakeDb({ rpc: () => ({ data: null, error: { message: "missing" } }) })
    expect((await GET()).status).toBe(500)
  })
})
