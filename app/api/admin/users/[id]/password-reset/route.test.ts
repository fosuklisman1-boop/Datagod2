import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { createHash } from "crypto"
import { ADMIN_ID, createFakeDb, USER_ID, type FakeDb, type FakeQuery, type GateMode } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({
  gate: "admin" as GateMode,
  fake: null as unknown as FakeDb,
  emails: [] as any[],
  emailOk: true,
}))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))
vi.mock("@/lib/email-service", () => ({
  sendEmail: vi.fn(async (p: any) => { h.emails.push(p); return h.emailOk ? { success: true } : { success: false, error: "smtp down" } }),
  EmailTemplates: { passwordReset: (url: string) => ({ subject: "Reset Your Password", html: `<a href="${url}">reset</a>` }) },
}))

import { POST as RAW_POST } from "./route"

const POST = async (id = USER_ID) =>
  (await RAW_POST(new NextRequest(`http://x/api/admin/users/${id}/password-reset`, { method: "POST", body: "{}" }), { params: Promise.resolve({ id }) }))!

const fake = (o: { user?: unknown; recent?: number } = {}) =>
  createFakeDb({
    tables: {
      users: () => ({ data: o.user === undefined ? { id: USER_ID, email: "ama@x.com", phone_number: "0244", first_name: "Ama" } : o.user, error: null }),
      password_reset_requests: (q: FakeQuery) =>
        q.kind === "insert" ? { data: { id: "tok-1" }, error: null } : { data: null, error: null, count: o.recent ?? 0 },
      admin_audit_log: () => ({ data: null, error: null }),
    },
  })

beforeEach(() => {
  h.gate = "admin"
  h.fake = fake()
  h.emails = []
  h.emailOk = true
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example"
})

describe("POST /api/admin/users/[id]/password-reset", () => {
  it("gates on verifyAdminAccess and refuses the CRON bypass", async () => {
    h.gate = "forbidden"
    expect((await POST()).status).toBe(403)
    h.gate = "cron"
    expect((await POST()).status).toBe(403)
    expect(h.fake.queries).toHaveLength(0)
    expect(h.emails).toHaveLength(0)
  })

  it("400s on a bad uuid", async () => {
    expect((await POST("nope")).status).toBe(400)
  })

  it("emails the app's reset link (same token table and URL as forgot-password) and audits it", async () => {
    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, email: "ama@x.com", expiresInMinutes: 5, audited: true })
    const insert = h.fake.ofTable("password_reset_requests").find((q) => q.kind === "insert")!
    expect(insert.payload).toMatchObject({ user_id: USER_ID, email: "ama@x.com", phone_number: "0244" })
    expect(h.emails).toHaveLength(1)
    expect(h.emails[0].to).toEqual([{ email: "ama@x.com", name: "Ama" }])
    expect(h.emails[0].htmlContent).toContain("https://app.example/auth/reset-password?token=tok-1")
    const [audit] = h.fake.ofTable("admin_audit_log")
    expect(audit.payload).toEqual([{
      admin_id: ADMIN_ID, action: "user_password_reset_sent", target_user_id: USER_ID,
      old_value: null,
      new_value: {
        email: "ama@x.com",
        expires_in_minutes: 5,
        reset_request_sha256: createHash("sha256").update("tok-1").digest("hex"),
      },
    }])
  })

  it("never puts the reset token or link in the audit row, the response, or the logs", async () => {
    const logs: string[] = []
    const spies = (["log", "info", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")) }))
    try {
      const res = await POST()
      const text = await res.text()
      const audit = JSON.stringify(h.fake.ofTable("admin_audit_log").map((q) => q.payload))
      for (const secret of ["tok-1", "reset-password?token", "/auth/reset-password"]) {
        expect(text, `response: ${secret}`).not.toContain(secret)
        expect(audit, `audit: ${secret}`).not.toContain(secret)
        for (const l of logs) expect(l, `log: ${secret}`).not.toContain(secret)
      }
      // The link did go to the user.
      expect(h.emails[0].htmlContent).toContain("tok-1")
    } finally {
      spies.forEach((s) => s.mockRestore())
    }
  })

  it("429 after 3 resets in the last hour, without creating a token", async () => {
    h.fake = fake({ recent: 3 })
    expect((await POST()).status).toBe(429)
    expect(h.fake.ofTable("password_reset_requests").filter((q) => q.kind === "insert")).toHaveLength(0)
  })

  it("404 for an unknown user, 400 without an email, 502 (no audit) when the email fails", async () => {
    h.fake = fake({ user: null })
    expect((await POST()).status).toBe(404)
    h.fake = fake({ user: { id: USER_ID, email: null, phone_number: "0244", first_name: null } })
    expect((await POST()).status).toBe(400)
    h.fake = fake()
    h.emailOk = false
    expect((await POST()).status).toBe(502)
    expect(h.fake.ofTable("admin_audit_log")).toHaveLength(0)
  })
})
