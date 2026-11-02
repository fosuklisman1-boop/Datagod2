import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { ADMIN_ID, createFakeDb, USER_ID, type FakeDb, type FakeQuery, type GateMode } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({ gate: "admin" as GateMode, fake: null as unknown as FakeDb }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))

import { POST as RAW_POST } from "./route"

const POST = async (body: unknown, id = USER_ID) =>
  (await RAW_POST(new NextRequest(`http://x/api/admin/users/${id}/phone-verified`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }))!

const fake = (user: unknown = { id: USER_ID, phone_number: "0244000000", phone_verified: false }) =>
  createFakeDb({
    tables: {
      users: (q: FakeQuery) => (q.kind === "update" ? { data: null, error: null } : { data: user, error: null }),
      admin_audit_log: () => ({ data: null, error: null }),
    },
  })

beforeEach(() => {
  h.gate = "admin"
  h.fake = fake()
})

describe("POST /api/admin/users/[id]/phone-verified", () => {
  it("gates on verifyAdminAccess and refuses the CRON bypass", async () => {
    h.gate = "forbidden"
    expect((await POST({ verified: true })).status).toBe(403)
    h.gate = "rate_limited"
    expect((await POST({ verified: true })).status).toBe(429)
    h.gate = "cron"
    expect((await POST({ verified: true })).status).toBe(403)
    expect(h.fake.queries).toHaveLength(0)
  })

  it("400s on a bad uuid or body", async () => {
    expect((await POST({ verified: true }, "bad")).status).toBe(400)
    for (const b of [{}, { verified: "yes" }, { verified: 1 }, null]) expect((await POST(b)).status, JSON.stringify(b)).toBe(400)
    expect(h.fake.queries).toHaveLength(0)
  })

  it("sets users.phone_verified and audits old and new", async () => {
    const res = await POST({ verified: true })
    expect(await res.json()).toEqual({ success: true, phoneVerified: true, changed: true, audited: true })
    const upd = h.fake.ofTable("users").find((q) => q.kind === "update")!
    expect(upd.payload).toMatchObject({ phone_verified: true })
    expect(upd.filter("id")).toBe(USER_ID)
    expect(h.fake.ofTable("admin_audit_log")[0].payload).toEqual([{
      admin_id: ADMIN_ID, action: "user_phone_verified", target_user_id: USER_ID,
      old_value: { phone_verified: false, phone_number: "0244000000" },
      new_value: { phone_verified: true, phone_number: "0244000000" },
    }])
  })

  it("un-verifies, is a no-op when unchanged, and refuses to verify without a number", async () => {
    h.fake = fake({ id: USER_ID, phone_number: "0244000000", phone_verified: true })
    await POST({ verified: false })
    expect((h.fake.ofTable("admin_audit_log")[0].payload as any)[0].action).toBe("user_phone_unverified")

    h.fake = fake({ id: USER_ID, phone_number: "0244000000", phone_verified: true })
    expect(await (await POST({ verified: true })).json()).toMatchObject({ changed: false })
    expect(h.fake.ofTable("users").filter((q) => q.kind === "update")).toHaveLength(0)
    expect(h.fake.ofTable("admin_audit_log")).toHaveLength(0)

    h.fake = fake({ id: USER_ID, phone_number: null, phone_verified: false })
    expect((await POST({ verified: true })).status).toBe(400)

    h.fake = fake(null)
    expect((await POST({ verified: true })).status).toBe(404)
  })
})
