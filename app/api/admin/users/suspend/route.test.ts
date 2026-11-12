import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { ADMIN_ID, createFakeDb, USER_ID, type FakeDb, type FakeQuery, type GateMode } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({ gate: "admin" as GateMode, fake: null as unknown as FakeDb, bans: [] as any[] }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => {}) }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(async () => ({ success: true })), SMSTemplates: { userSuspended: () => "s", userUnsuspended: () => "u" } }))
vi.mock("@/lib/email-service", () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  EmailTemplates: { userSuspended: () => ({ subject: "s", html: "h" }), userUnsuspended: () => ({ subject: "u", html: "h" }) },
}))

import { POST as RAW_POST } from "./route"

const POST = async (body: unknown) =>
  (await RAW_POST(new NextRequest("http://x/api/admin/users/suspend", { method: "POST", body: JSON.stringify(body) })))!

beforeEach(() => {
  h.gate = "admin"
  h.bans = []
  h.fake = createFakeDb({
    tables: {
      users: (q: FakeQuery) => (q.kind === "update" ? { data: null, error: null } : { data: { email: "a@x.com", phone_number: null, first_name: "A" }, error: null }),
      admin_audit_log: () => ({ data: null, error: null }),
    },
  })
  ;(h.fake.db.auth.admin as any).updateUserById = async (id: string, attrs: unknown) => { h.bans.push({ id, attrs }); return { error: null } }
})

describe("POST /api/admin/users/suspend", () => {
  it("honours the gate's 403 and its 429 (rate limit)", async () => {
    h.gate = "forbidden"
    expect((await POST({ userId: USER_ID, action: "suspend" })).status).toBe(403)
    h.gate = "rate_limited"
    expect((await POST({ userId: USER_ID, action: "suspend" })).status).toBe(429)
    expect(h.bans).toHaveLength(0)
    expect(h.fake.queries).toHaveLength(0)
  })

  it("400s on a bad user id or action", async () => {
    expect((await POST({ userId: "nope", action: "suspend" })).status).toBe(400)
    expect((await POST({ userId: USER_ID, action: "ban" })).status).toBe(400)
    expect(h.bans).toHaveLength(0)
  })

  it("suspends and audits with the trimmed reason", async () => {
    const res = await POST({ userId: USER_ID, action: "suspend", reason: "  chargebacks  " })
    expect(res.status).toBe(200)
    expect(h.bans).toEqual([{ id: USER_ID, attrs: { ban_duration: "876000h" } }])
    expect(h.fake.ofTable("admin_audit_log")[0].payload).toEqual([{
      admin_id: ADMIN_ID, action: "user_suspend", target_user_id: USER_ID,
      old_value: { is_suspended: false }, new_value: { is_suspended: true, reason: "chargebacks" },
    }])
  })

  it("still works for the CRON bypass (AI scheduled tasks), without an audit row", async () => {
    h.gate = "cron"
    expect((await POST({ userId: USER_ID, action: "unsuspend" })).status).toBe(200)
    expect(h.fake.ofTable("admin_audit_log")).toHaveLength(0)
  })
})
