import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { ADMIN_ID, createFakeDb, USER_ID, type FakeDb, type FakeQuery, type GateMode } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({
  gate: "admin" as GateMode,
  fake: null as unknown as FakeDb,
  profile: null as null | { email: string | null; phone_number: string | null; role: string | null },
  authUser: null as null | { id: string; email?: string; phone?: string; user_metadata?: Record<string, unknown> },
  auditError: false,
  deleted: [] as string[],
  /** Every call in order: "<table>:<kind>" and "auth:deleteUser". */
  log: [] as string[],
}))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))

import { DELETE as RAW_DELETE } from "./route"

const DELETE = async (body: unknown) =>
  (await RAW_DELETE(new NextRequest("http://x/api/admin/remove-user", { method: "DELETE", body: JSON.stringify(body) })))!

const ok = () => ({ data: null, error: null })

beforeEach(() => {
  h.gate = "admin"
  h.profile = { email: "gone@x.com", phone_number: "0244000009", role: "user" }
  h.authUser = { id: USER_ID, email: "gone@x.com", user_metadata: {} }
  h.auditError = false
  h.deleted = []
  h.log = []
  const table = (name: string) => (q: FakeQuery) => {
    h.log.push(`${name}:${q.kind}`)
    if (name === "users" && q.kind === "select") return { data: h.profile, error: null }
    if (name === "user_shops" && q.kind === "select") return { data: [], error: null }
    if (name === "admin_audit_log") return h.auditError ? { data: null, error: { message: "audit down" } } : ok()
    return ok()
  }
  const tables: Record<string, (q: FakeQuery) => any> = {}
  for (const t of ["users", "admin_audit_log", "notifications", "complaints", "transactions", "withdrawal_requests", "orders",
    "afa_orders", "shop_invites", "user_shops", "wallets"]) tables[t] = table(t)
  h.fake = createFakeDb({
    tables,
    getUserById: () => (h.authUser ? { data: { user: h.authUser }, error: null } : { data: { user: null }, error: { message: "User not found" } }),
  })
  ;(h.fake.db.auth.admin as any).deleteUser = async (id: string) => { h.log.push("auth:deleteUser"); h.deleted.push(id); return { error: null } }
})

describe("DELETE /api/admin/remove-user", () => {
  it("honours 403 / 429 and refuses the CRON bypass (no admin to attribute the deletion to)", async () => {
    for (const [g, status] of [["forbidden", 403], ["rate_limited", 429], ["cron", 403]] as const) {
      h.gate = g
      expect((await DELETE({ userId: USER_ID })).status, g).toBe(status)
    }
    expect(h.log).toEqual([])
  })

  it("400s on a bad id", async () => {
    expect((await DELETE({ userId: "nope" })).status).toBe(400)
    expect(h.log).toEqual([])
  })

  it("refuses to delete the caller's own account", async () => {
    const res = await DELETE({ userId: ADMIN_ID })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/your own account/i)
    expect(h.deleted).toEqual([])
    expect(h.log.filter((l) => l.endsWith(":delete"))).toEqual([])
  })

  it("refuses to delete an admin (role in users, or in the auth metadata)", async () => {
    h.profile = { email: "a@x.com", phone_number: null, role: "admin" }
    let res = await DELETE({ userId: USER_ID })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/admin/i)
    h.profile = null
    h.authUser = { id: USER_ID, email: "a@x.com", user_metadata: { role: "admin" } }
    res = await DELETE({ userId: USER_ID })
    expect(res.status).toBe(403)
    expect(h.deleted).toEqual([])
    expect(h.log.filter((l) => l.endsWith(":delete") || l === "admin_audit_log:insert")).toEqual([])
  })

  it("404s an unknown user", async () => {
    h.profile = null
    h.authUser = null
    expect((await DELETE({ userId: USER_ID })).status).toBe(404)
    expect(h.deleted).toEqual([])
  })

  it("writes a user_removed audit row (email, phone, role) before deleting anything", async () => {
    const res = await DELETE({ userId: USER_ID })
    expect(res.status).toBe(200)
    expect(h.fake.ofTable("admin_audit_log")[0].payload).toEqual([{
      admin_id: ADMIN_ID, action: "user_removed", target_user_id: USER_ID, old_value: null,
      new_value: { email: "gone@x.com", phone: "0244000009", role: "user" },
    }])
    const firstDelete = h.log.findIndex((l) => l.endsWith(":delete"))
    expect(h.log.indexOf("admin_audit_log:insert")).toBeGreaterThan(-1)
    expect(h.log.indexOf("admin_audit_log:insert")).toBeLessThan(firstDelete)
    expect(h.deleted).toEqual([USER_ID])
  })

  it("does not delete when the audit row cannot be written", async () => {
    h.auditError = true
    const res = await DELETE({ userId: USER_ID })
    expect(res.status).toBe(500)
    expect(h.log.filter((l) => l.endsWith(":delete"))).toEqual([])
    expect(h.deleted).toEqual([])
  })

  it("uses the auth user's email when there is no profile row", async () => {
    h.profile = null
    h.authUser = { id: USER_ID, email: "authonly@x.com", phone: "233244000009", user_metadata: {} }
    expect((await DELETE({ userId: USER_ID })).status).toBe(200)
    expect((h.fake.ofTable("admin_audit_log")[0].payload as any[])[0].new_value).toEqual({ email: "authonly@x.com", phone: "233244000009", role: "user" })
  })
})
