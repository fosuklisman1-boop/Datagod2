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
  (await RAW_GET(new NextRequest(`http://x/api/admin/users/${id}/audit${qs}`), { params: Promise.resolve({ id }) }))!
const ROWS = [
  { id: "a2", admin_id: "adm-1", action: "wallet_credit", old_value: { balance: 1 }, new_value: { balance: 2 }, created_at: "2026-10-02" },
  { id: "a1", admin_id: "adm-2", action: "user_suspend", old_value: null, new_value: { reason: "fraud" }, created_at: "2026-10-01" },
  { id: "a0", admin_id: "adm-1", action: "user_force_logout", old_value: null, new_value: null, created_at: "2026-09-01" },
]

beforeEach(() => {
  h.gate = "admin"
  h.fake = createFakeDb({
    tables: {
      admin_audit_log: () => ({ data: ROWS, error: null, count: 3 }),
      users: () => ({ data: [{ id: "adm-1", email: "one@x.com" }], error: null }),
    },
  })
})

describe("GET /api/admin/users/[id]/audit", () => {
  it("gates on verifyAdminAccess", async () => {
    h.gate = "forbidden"
    expect((await GET()).status).toBe(403)
    expect(h.fake.queries).toHaveLength(0)
  })

  it("400s on a bad uuid or bad paging", async () => {
    expect((await GET("", "x")).status).toBe(400)
    expect((await GET("?page=a")).status).toBe(400)
    expect((await GET("?pageSize=500")).status).toBe(400)
    expect(h.fake.queries).toHaveLength(0)
  })

  it("pages the user's audit rows newest first and adds the acting admin's email", async () => {
    const res = await GET("?page=2&pageSize=5")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(3)
    expect(body.page).toBe(2)
    expect(body.rows.map((r: any) => r.admin_email)).toEqual(["one@x.com", null, "one@x.com"])
    const [q] = h.fake.ofTable("admin_audit_log")
    expect(q.filter("target_user_id")).toBe(USER_ID)
    expect(q.count).toBe("exact")
    expect(q.op("order")).toEqual(["order", "created_at", { ascending: false }])
    expect(q.op("range")).toEqual(["range", 5, 9])
    // One lookup for the distinct admins on this page.
    const users = h.fake.ofTable("users")
    expect(users).toHaveLength(1)
    expect(users[0].op("in")).toEqual(["in", "id", ["adm-1", "adm-2"]])
  })

  it("500s on a query error", async () => {
    h.fake = createFakeDb({ tables: { admin_audit_log: () => ({ data: null, error: { message: "boom" } }) } })
    expect((await GET()).status).toBe(500)
  })
})
