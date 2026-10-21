// The shared SMS phone-OTP core (send/verify routes + bot payer verification). Route-level behaviour is pinned in
// app/api/auth/*-phone-otp/route.test.ts; this covers the core directly, including hasLivePhoneOtp.
import { describe, it, expect, vi } from "vitest"
import { checkPhoneOtp, defaultPhoneOtpCode, hasLivePhoneOtp, issuePhoneOtp, phoneOtpVerifyLimitId, PHONE_OTP_VERIFY_PHONE_LIMIT, type PhoneOtpDeps } from "./phone-otp"
import { fakeOtpDb, otpRow, type FakeOtpDbOptions, type OtpRow } from "./phone-otp.fake"

const NOW = Date.parse("2026-10-21T10:00:00Z")
const PHONE = "0241234567"

function deps(rows: OtpRow[] = [], o: Partial<FakeOtpDbOptions> = {}) {
  const f = fakeOtpDb(rows, { now: () => NOW, ...o })
  const sent: [string, string][] = []
  const d: PhoneOtpDeps = {
    db: f.client as any,
    sendCode: vi.fn(async (p: string, c: string) => { sent.push([p, c]); return { success: true } }),
    now: () => NOW,
    randomCode: () => "246810",
  }
  return { d, f, sent }
}

describe("issuePhoneOtp", () => {
  it("stores the code (10-min expiry, purpose) and sends it; returns the SMS result", async () => {
    const { d, f, sent } = deps()
    expect(await issuePhoneOtp(d, PHONE, "signup")).toEqual({ ok: true, sms: { success: true } })
    expect(f.rows[0]).toMatchObject({ phone: PHONE, code: "246810", purpose: "signup", expires_at: new Date(NOW + 600_000).toISOString() })
    expect(sent).toEqual([[PHONE, "246810"]])
  })

  it("3 codes in the hour => PHONE_LIMIT, nothing stored or sent", async () => {
    const { d, f, sent } = deps([1, 2, 3].map(i => otpRow({ phone: PHONE, code: `10000${i}` }, NOW)))
    expect(await issuePhoneOtp(d, PHONE, "signup")).toEqual({ ok: false, reason: "PHONE_LIMIT" })
    expect(f.rows).toHaveLength(3)
    expect(sent).toEqual([])
  })

  it("insert error => INSERT_FAILED, no SMS", async () => {
    const { d, sent } = deps([], { insertError: true })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await issuePhoneOtp(d, PHONE, "signup")).toEqual({ ok: false, reason: "INSERT_FAILED" })
    expect(sent).toEqual([])
    spy.mockRestore()
  })

  it("a throwing SMS propagates", async () => {
    const { d } = deps()
    d.sendCode = async () => { throw new Error("sms down") }
    await expect(issuePhoneOtp(d, PHONE, "signup")).rejects.toThrow("sms down")
  })
})

describe("checkPhoneOtp", () => {
  it("verified marks the row used", async () => {
    const { d, f } = deps([otpRow({ phone: PHONE, code: "123456" }, NOW)])
    expect(await checkPhoneOtp(d, PHONE, "123456", "signup")).toBe("verified")
    expect(f.rows[0].used).toBe(true)
  })
  it("verifies once only", async () => {
    const { d } = deps([otpRow({ phone: PHONE, code: "123456" }, NOW)])
    expect(await checkPhoneOtp(d, PHONE, "123456", "signup")).toBe("verified")
    expect(await checkPhoneOtp(d, PHONE, "123456", "signup")).toBe("invalid")
  })
  it("wrong / expired => invalid", async () => {
    const { d } = deps([otpRow({ phone: PHONE, code: "123456" }, NOW), otpRow({ phone: PHONE, code: "222222", expires_at: new Date(NOW - 1).toISOString() }, NOW)])
    expect(await checkPhoneOtp(d, PHONE, "000000", "signup")).toBe("invalid")
    expect(await checkPhoneOtp(d, PHONE, "222222", "signup")).toBe("invalid")
  })
  it("attempt counter above 6 => too_many_attempts; RPC error / throw => unavailable", async () => {
    expect(await checkPhoneOtp(deps([otpRow({ phone: PHONE, code: "1", attempts: 6 }, NOW)]).d, PHONE, "1", "signup")).toBe("too_many_attempts")
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await checkPhoneOtp(deps([], { rpc: "error" }).d, PHONE, "1", "signup")).toBe("unavailable")
    expect(await checkPhoneOtp(deps([], { rpc: "throw" }).d, PHONE, "1", "signup")).toBe("unavailable")
    spy.mockRestore()
  })
})

describe("hasLivePhoneOtp", () => {
  it("true only for an unused, unexpired code of this phone + purpose", async () => {
    expect(await hasLivePhoneOtp(deps([otpRow({ phone: PHONE, code: "1" }, NOW)]).d, PHONE, "signup")).toBe(true)
    expect(await hasLivePhoneOtp(deps([otpRow({ phone: PHONE, code: "1", used: true }, NOW)]).d, PHONE, "signup")).toBe(false)
    expect(await hasLivePhoneOtp(deps([otpRow({ phone: PHONE, code: "1", expires_at: new Date(NOW - 1).toISOString() }, NOW)]).d, PHONE, "signup")).toBe(false)
    expect(await hasLivePhoneOtp(deps([otpRow({ phone: PHONE, code: "1", purpose: "x" }, NOW)]).d, PHONE, "signup")).toBe(false)
    expect(await hasLivePhoneOtp(deps([]).d, PHONE, "signup")).toBe(false)
  })
  it("throws on a DB error", async () => {
    await expect(hasLivePhoneOtp(deps([], { selectError: true }).d, PHONE, "signup")).rejects.toBeTruthy()
  })
})

describe("defaultPhoneOtpCode", () => {
  it("6 digits, 100000..999999, from crypto.randomInt (never Math.random)", () => {
    const spy = vi.spyOn(Math, "random")
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const c = defaultPhoneOtpCode()
      expect(c).toMatch(/^[1-9]\d{5}$/)
      seen.add(c)
    }
    expect(spy).not.toHaveBeenCalled()
    expect(seen.size).toBeGreaterThan(450)
    spy.mockRestore()
  })
})

describe("verify limit", () => {
  it("name / max / window and the otpv:<digits> id match the route", () => {
    expect(PHONE_OTP_VERIFY_PHONE_LIMIT).toEqual({ name: "verify_phone_otp_phone", max: 6, windowMs: 600_000 })
    expect(phoneOtpVerifyLimitId("+233 24 123 4567")).toBe("otpv:233241234567")
  })
})
