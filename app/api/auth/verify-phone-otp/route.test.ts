// Characterization of POST /api/auth/verify-phone-otp: Upstash caps (per phone 6 / 10 min keyed otpv:<digits>, per IP
// 20 / min), the bump_otp_attempts DB fallback (fail closed 503 when unavailable, 429 above 6), the code match
// (phone + code + purpose + unused + unexpired, newest) and the used=true write. Pins the route across the
// lib/phone-otp extraction.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { fakeOtpDb, otpRow, type FakeOtpDbOptions, type OtpRow } from "@/lib/phone-otp.fake"

const h = vi.hoisted(() => ({
  db: null as any,
  limits: {} as Record<string, boolean>,
  limitCalls: [] as unknown[][],
}))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.db.client }))
vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: vi.fn(async (_req: unknown, name: string, ...rest: unknown[]) => {
    h.limitCalls.push([name, ...rest])
    return { allowed: h.limits[name] ?? true }
  }),
}))

import { POST } from "./route"

const NOW = Date.parse("2026-10-21T10:00:00Z")
const PHONE = "0241234567"

function world(rows: OtpRow[] = [], o: Partial<FakeOtpDbOptions> = {}) {
  h.db = fakeOtpDb(rows, { now: () => Date.now(), ...o })
  return h.db as ReturnType<typeof fakeOtpDb>
}
const req = (body: unknown) => new NextRequest("http://localhost/api/auth/verify-phone-otp", { method: "POST", body: JSON.stringify(body) })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  h.limits = {}
  h.limitCalls = []
  world()
})
afterEach(() => { vi.useRealTimers() })

describe("POST /api/auth/verify-phone-otp", () => {
  it("the right code => 200 { verified: true } and that row used=true", async () => {
    const w = world([otpRow({ id: "a", phone: PHONE, code: "123456" }, NOW), otpRow({ id: "b", phone: PHONE, code: "654321" }, NOW)])
    const res = await POST(req({ phone: PHONE, code: "123456" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ verified: true })
    expect(w.rows.find(r => r.id === "a")!.used).toBe(true)
    expect(w.rows.find(r => r.id === "b")!.used).toBe(false)
    expect(w.rpcCalls).toEqual([{ fn: "bump_otp_attempts", args: { p_phone: PHONE } }])
  })

  it("caps: per phone (otpv:<digits>, 6 / 10 min) then per IP (20 / min)", async () => {
    world([otpRow({ phone: PHONE, code: "123456" }, NOW)])
    await POST(req({ phone: "024-123-4567", code: "123456" }))
    expect(h.limitCalls).toEqual([
      ["verify_phone_otp_phone", 6, 10 * 60 * 1000, "otpv:0241234567"],
      ["verify_phone_otp_ip", 20, 60 * 1000],
    ])
  })

  it("missing phone or code => 400", async () => {
    for (const body of [{}, { phone: PHONE }, { code: "123456" }]) {
      const res = await POST(req(body))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "Phone and code are required" })
    }
  })

  it("per-phone cap hit => 429, nothing bumped", async () => {
    h.limits.verify_phone_otp_phone = false
    const w = world([otpRow({ phone: PHONE, code: "123456" }, NOW)])
    const res = await POST(req({ phone: PHONE, code: "123456" }))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ verified: false, error: "Too many attempts. Request a new code and try again later." })
    expect(w.rpcCalls).toHaveLength(0)
    expect(w.rows[0].used).toBe(false)
  })

  it("per-IP cap hit => 429", async () => {
    h.limits.verify_phone_otp_ip = false
    const res = await POST(req({ phone: PHONE, code: "123456" }))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ verified: false, error: "Too many attempts. Please wait a moment." })
  })

  it("DB attempt counter above 6 => 429 even with the right code", async () => {
    const w = world([otpRow({ phone: PHONE, code: "123456", attempts: 6 }, NOW)])
    const res = await POST(req({ phone: PHONE, code: "123456" }))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ verified: false, error: "Too many attempts. Request a new code and try again later." })
    expect(w.rows[0].used).toBe(false)
  })

  it("the 6th attempt is still allowed (cap is > 6)", async () => {
    world([otpRow({ phone: PHONE, code: "123456", attempts: 5 }, NOW)])
    const res = await POST(req({ phone: PHONE, code: "123456" }))
    expect(res.status).toBe(200)
  })

  for (const mode of ["error", "throw"] as const) {
    it(`bump_otp_attempts ${mode} => fail closed 503, nothing verified`, async () => {
      const w = world([otpRow({ phone: PHONE, code: "123456" }, NOW)], { rpc: mode })
      const spy = vi.spyOn(console, "error").mockImplementation(() => {})
      const res = await POST(req({ phone: PHONE, code: "123456" }))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ verified: false, error: "Verification is temporarily unavailable. Please try again shortly." })
      expect(w.rows[0].used).toBe(false)
      spy.mockRestore()
    })
  }

  const invalid: [string, OtpRow[], Record<string, unknown>][] = [
    ["wrong code", [otpRow({ phone: PHONE, code: "123456" }, NOW)], { code: "000000" }],
    ["expired code", [otpRow({ phone: PHONE, code: "123456", expires_at: new Date(NOW - 1000).toISOString() }, NOW)], {}],
    ["already used", [otpRow({ phone: PHONE, code: "123456", used: true }, NOW)], {}],
    ["other purpose", [otpRow({ phone: PHONE, code: "123456", purpose: "update_phone" }, NOW)], {}],
    ["other phone format", [otpRow({ phone: "233241234567", code: "123456" }, NOW)], {}],
  ]
  for (const [name, rows, body] of invalid) {
    it(`${name} => 400 'Invalid or expired code'`, async () => {
      const before = rows.map(r => r.used)
      const w = world(rows)
      const res = await POST(req({ phone: PHONE, code: "123456", ...body }))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ verified: false, error: "Invalid or expired code" })
      expect(w.rows.map(r => r.used)).toEqual(before)
    })
  }

  it("matching purpose is honoured", async () => {
    const w = world([otpRow({ phone: PHONE, code: "123456", purpose: "update_phone" }, NOW)])
    const res = await POST(req({ phone: PHONE, code: "123456", purpose: "update_phone" }))
    expect(res.status).toBe(200)
    expect(w.rows[0].used).toBe(true)
  })

  it("a lookup error reads as invalid (400)", async () => {
    world([otpRow({ phone: PHONE, code: "123456" }, NOW)], { selectError: true })
    const res = await POST(req({ phone: PHONE, code: "123456" }))
    expect(res.status).toBe(400)
  })
})
