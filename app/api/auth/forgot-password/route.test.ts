import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { createFakeDb, type FakeDb, type FakeQuery } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({
  fake: null as unknown as FakeDb,
  rateLimited: false,
  emails: [] as any[],
  sms: [] as any[],
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))
vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: vi.fn(async () => ({ allowed: !h.rateLimited, resetAt: Date.now() + 60_000 })),
}))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: vi.fn(async (p: any) => { h.sms.push(p); return { success: true } }),
  SMSTemplates: { passwordReset: (url: string) => `reset: ${url}` },
}))
vi.mock("@/lib/email-service", () => ({
  sendEmail: vi.fn(async (p: any) => { h.emails.push(p); return { success: true } }),
  EmailTemplates: { passwordReset: (url: string) => ({ subject: "Reset Your Password", html: `<a href="${url}">x</a>` }) },
}))

import { POST as RAW_POST } from "./route"

const POST = async (contact: string) =>
  (await RAW_POST(new NextRequest("http://x/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ contact }) })))!
const USER = { id: "u1", email: "ama@x.com", phone_number: "0244000000", first_name: "Ama" }
const GENERIC = "If an account matches that contact information, a password reset link has been sent."

const fake = (o: { user?: unknown; recent?: number } = {}) =>
  createFakeDb({
    tables: {
      users: () => ({ data: o.user === undefined ? USER : o.user, error: null }),
      password_reset_requests: (q: FakeQuery) =>
        q.kind === "insert" ? { data: { id: "tok-1" }, error: null } : { data: null, error: null, count: o.recent ?? 0 },
    },
  })

beforeEach(() => {
  h.fake = fake()
  h.rateLimited = false
  h.emails = []
  h.sms = []
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example"
})

describe("POST /api/auth/forgot-password", () => {
  it("does not reveal whether an account exists: unknown contacts get the same 200 and nothing is sent", async () => {
    h.fake = fake({ user: null })
    const res = await POST("nobody@x.com")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, message: GENERIC, methods: { email: true, sms: false } })
    expect(h.fake.ofTable("password_reset_requests")).toHaveLength(0)
    expect(h.emails).toHaveLength(0)
    expect(h.sms).toHaveLength(0)
  })

  it("silently drops a 4th request within the hour: same generic 200, no token, nothing sent", async () => {
    h.fake = fake({ recent: 3 })
    const res = await POST("ama@x.com")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, message: GENERIC, methods: { email: true, sms: false } })
    expect(h.fake.ofTable("password_reset_requests").filter((q) => q.kind === "insert")).toHaveLength(0)
    expect(h.emails).toHaveLength(0)
    expect(h.sms).toHaveLength(0)
  })

  it("under the limit, creates a 5-minute token and sends the reset link by email and SMS", async () => {
    h.fake = fake({ recent: 2 })
    const before = Date.now()
    const res = await POST("ama@x.com")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, message: GENERIC, methods: { email: true, sms: true } })
    const insert = h.fake.ofTable("password_reset_requests").find((q) => q.kind === "insert")!
    const expires = Date.parse((insert.payload as { expires_at: string }).expires_at)
    expect(expires - before).toBeGreaterThanOrEqual(5 * 60_000 - 50)
    expect(expires - before).toBeLessThanOrEqual(5 * 60_000 + 5_000)
    expect(h.emails[0].htmlContent).toContain("https://app.example/auth/reset-password?token=tok-1")
    expect(h.sms[0].message).toBe("reset: https://app.example/auth/reset-password?token=tok-1")
  })

  it("400 without a contact; 429 when the IP rate limit is hit", async () => {
    expect((await POST("  ")).status).toBe(400)
    h.rateLimited = true
    expect((await POST("ama@x.com")).status).toBe(429)
  })
})
