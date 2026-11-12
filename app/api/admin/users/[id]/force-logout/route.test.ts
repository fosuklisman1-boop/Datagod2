import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { ADMIN_ID, createFakeDb, USER_ID, type FakeDb, type GateMode } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({ gate: "admin" as GateMode, fake: null as unknown as FakeDb }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))

import { POST as RAW_POST } from "./route"

const POST = async (id = USER_ID) =>
  (await RAW_POST(new NextRequest(`http://x/api/admin/users/${id}/force-logout`, { method: "POST", body: "{}" }), { params: Promise.resolve({ id }) }))!

const fake = (o: { rpcError?: boolean; auditError?: boolean; noUser?: boolean } = {}) =>
  createFakeDb({
    rpc: () => (o.rpcError ? { data: null, error: { message: "boom" } } : { data: 3, error: null }),
    tables: { admin_audit_log: () => ({ data: null, error: o.auditError ? { message: "audit down" } : null }) },
    getUserById: () => (o.noUser ? { data: { user: null }, error: { message: "User not found" } } : { data: { user: { id: USER_ID } }, error: null }),
  })

beforeEach(() => {
  h.gate = "admin"
  h.fake = fake()
})

describe("POST /api/admin/users/[id]/force-logout", () => {
  it("returns the gate's response for non-admins and rate-limited admins", async () => {
    h.gate = "forbidden"
    expect((await POST()).status).toBe(403)
    h.gate = "rate_limited"
    expect((await POST()).status).toBe(429)
    expect(h.fake.rpcCalls).toHaveLength(0)
  })

  it("refuses the CRON bypass (no admin id to audit)", async () => {
    h.gate = "cron"
    const res = await POST()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/Admin session required/)
    expect(h.fake.rpcCalls).toHaveLength(0)
  })

  it("400s on a bad uuid", async () => {
    expect((await POST("x")).status).toBe(400)
    expect(h.fake.rpcCalls).toHaveLength(0)
  })

  it("revokes every session through revoke_other_user_sessions(p_keep null) and audits it", async () => {
    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, sessionsRevoked: 3, audited: true })
    expect(h.fake.rpcCalls).toEqual([{ name: "revoke_other_user_sessions", args: { p_uid: USER_ID, p_keep: null } }])
    const [audit] = h.fake.ofTable("admin_audit_log")
    expect(audit.kind).toBe("insert")
    expect(audit.payload).toEqual([{
      admin_id: ADMIN_ID, action: "user_force_logout", target_user_id: USER_ID,
      old_value: null, new_value: { sessions_revoked: 3 },
    }])
  })

  it("404 for an unknown user; 500 (and no audit) when the RPC fails; reports a failed audit", async () => {
    h.fake = fake({ noUser: true })
    expect((await POST()).status).toBe(404)
    h.fake = fake({ rpcError: true })
    expect((await POST()).status).toBe(500)
    expect(h.fake.ofTable("admin_audit_log")).toHaveLength(0)
    h.fake = fake({ auditError: true })
    expect((await (await POST()).json()).audited).toBe(false)
  })
})
