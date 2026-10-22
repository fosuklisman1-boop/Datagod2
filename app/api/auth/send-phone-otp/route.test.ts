// Characterization of POST /api/auth/send-phone-otp: IP caps (hourly + burst), input checks, the per-phone DB cap
// (3 codes / phone / hour), the stored row and the SMS. Pins the route's behaviour across the lib/phone-otp extraction.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { fakeOtpDb, otpRow, type FakeOtpDbOptions, type OtpRow } from "@/lib/testing/phone-otp-fakes"

const h = vi.hoisted(() => ({
  db: null as any,
  limits: {} as Record<string, boolean>,
  sendSMS: null as any,
  limitCalls: [] as unknown[][],
}))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.db.client }))
vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: vi.fn(async (_req: unknown, name: string, ...rest: unknown[]) => {
    h.limitCalls.push([name, ...rest])
    return { allowed: h.limits[name] ?? true }
  }),
}))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: (p: unknown) => h.sendSMS(p),
  SMSTemplates: { verificationCode: (code: string) => `DTGOD: Your code is ${code}. Valid for 10 minutes. Do not share it with anyone.` },
}))

import { POST } from "./route"

const NOW = Date.parse("2026-10-21T10:00:00Z")
const PHONE = "0241234567"

function world(rows: OtpRow[] = [], o: Partial<FakeOtpDbOptions> = {}) {
  h.db = fakeOtpDb(rows, { now: () => Date.now(), ...o })
  return h.db as ReturnType<typeof fakeOtpDb>
}
const req = (body: unknown) => new NextRequest("http://localhost/api/auth/send-phone-otp", { method: "POST", body: JSON.stringify(body) })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  h.limits = {}
  h.limitCalls = []
  h.sendSMS = vi.fn(async () => ({ success: true }))
  world()
})
afterEach(() => { vi.useRealTimers() })

describe("POST /api/auth/send-phone-otp", () => {
  it("happy path: one row (6-digit code, 10-min expiry, default purpose signup), the SMS, { sent: true }", async () => {
    const w = world()
    const res = await POST(req({ phone: PHONE }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sent: true })
    expect(w.rows).toHaveLength(1)
    const row = w.rows[0]
    expect(row).toMatchObject({ phone: PHONE, purpose: "signup", expires_at: new Date(NOW + 10 * 60 * 1000).toISOString() })
    expect(row.code).toMatch(/^[1-9]\d{5}$/)
    expect(h.sendSMS).toHaveBeenCalledWith({
      phone: PHONE, message: `DTGOD: Your code is ${row.code}. Valid for 10 minutes. Do not share it with anyone.`, type: "phone_otp",
    })
    // The insert payload is exactly { phone, code, expires_at, purpose }.
    const ins = w.calls.find(c => c.op === "insert")!
    expect(Object.keys(ins.payload as object).sort()).toEqual(["code", "expires_at", "phone", "purpose"])
  })

  it("passes the given purpose through", async () => {
    const w = world()
    await POST(req({ phone: PHONE, purpose: "update_phone" }))
    expect(w.rows[0].purpose).toBe("update_phone")
  })

  it("IP caps: phone_otp (5/h) then phone_otp_burst (2/min)", async () => {
    await POST(req({ phone: PHONE }))
    expect(h.limitCalls).toEqual([["phone_otp", 5, 60 * 60 * 1000], ["phone_otp_burst", 2, 60_000]])
  })

  it("IP hourly cap hit => 429, no row, no SMS", async () => {
    h.limits.phone_otp = false
    const w = world()
    const res = await POST(req({ phone: PHONE }))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: "Too many OTP requests. Please try again later." })
    expect(w.rows).toHaveLength(0)
    expect(h.sendSMS).not.toHaveBeenCalled()
  })

  it("IP burst cap hit => 429", async () => {
    h.limits.phone_otp_burst = false
    const res = await POST(req({ phone: PHONE }))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: "Please wait a moment before requesting another code." })
  })

  it("missing / blank phone => 400", async () => {
    for (const body of [{}, { phone: "" }, { phone: "   " }]) {
      const res = await POST(req(body))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "Phone number is required" })
    }
  })

  it("wrong digit count => 400", async () => {
    for (const phone of ["02412345", "233241234567"]) {
      const res = await POST(req({ phone }))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "Phone number must be 9 or 10 digits" })
    }
  })

  it("per-phone cap: 3 codes in the last hour => 429, no new row, no SMS", async () => {
    const seed = [1, 2, 3].map(i => otpRow({ phone: PHONE, code: `11111${i}`, created_at: new Date(NOW - i * 10 * 60 * 1000).toISOString() }, NOW))
    const w = world(seed)
    const res = await POST(req({ phone: PHONE }))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: "Too many OTP requests for this number. Please try again later." })
    expect(w.rows).toHaveLength(3)
    expect(h.sendSMS).not.toHaveBeenCalled()
  })

  it("per-phone cap counts only the last hour and only this exact phone string", async () => {
    const seed = [
      otpRow({ phone: PHONE, code: "111111", created_at: new Date(NOW - 61 * 60 * 1000).toISOString() }, NOW),
      otpRow({ phone: PHONE, code: "111112" }, NOW),
      otpRow({ phone: PHONE, code: "111113" }, NOW),
      otpRow({ phone: "233241234567", code: "111114" }, NOW),
    ]
    const w = world(seed)
    const res = await POST(req({ phone: PHONE }))
    expect(res.status).toBe(200)
    expect(w.rows).toHaveLength(5)
  })

  it("a count error (count null) does not block", async () => {
    const w = world([], { countError: true })
    const res = await POST(req({ phone: PHONE }))
    expect(res.status).toBe(200)
    expect(w.rows).toHaveLength(1)
  })

  it("insert error => 500 'Failed to generate OTP', no SMS", async () => {
    world([], { insertError: true })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await POST(req({ phone: PHONE }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Failed to generate OTP" })
    expect(h.sendSMS).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it("an SMS that reports failure still answers { sent: true } (unchanged legacy behaviour)", async () => {
    h.sendSMS = vi.fn(async () => ({ success: false, error: "provider down" }))
    const res = await POST(req({ phone: PHONE }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sent: true })
  })

  it("an SMS that throws => 500 'Failed to send OTP' (the row stays)", async () => {
    const w = world()
    h.sendSMS = vi.fn(async () => { throw new Error("boom") })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await POST(req({ phone: PHONE }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Failed to send OTP" })
    expect(w.rows).toHaveLength(1)
    spy.mockRestore()
  })
})
