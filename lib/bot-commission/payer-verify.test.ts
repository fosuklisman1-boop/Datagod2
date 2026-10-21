// Bot payer verification: the WhatsApp bots SMS a code to the typed MoMo number and check the code the buyer types
// back in the chat. Same table + rules as /api/auth/*-phone-otp (lib/phone-otp); a success writes used=true, so
// isPhoneOtpVerified(payPhone) then passes and botChargeMomo stops answering NEEDS_VERIFY.
import { describe, it, expect, vi } from "vitest"
import { createPayerVerify, PAYER_OTP_BURST, PAYER_OTP_PURPOSE, type PayerVerifyDeps } from "./payer-verify"
import { fakeOtpDb, otpRow, type FakeOtpDbOptions, type OtpRow } from "@/lib/phone-otp.fake"

const NOW = Date.parse("2026-10-21T10:00:00Z")
const LOCAL = "0241234567"

function make(rows: OtpRow[] = [], o: Partial<FakeOtpDbOptions> = {}, sms: unknown = { success: true }) {
  let now = NOW
  const f = fakeOtpDb(rows, { now: () => now, ...o })
  /** Sliding-window limiter stand-in (hit times per key). */
  const limits = new Map<string, number[]>()
  const blocked = new Set<string>()
  const sent: [string, string][] = []
  const deps: PayerVerifyDeps = {
    db: f.client as any,
    sendCode: vi.fn(async (p: string, c: string) => { sent.push([p, c]); if (sms instanceof Error) throw sms; return sms }),
    now: () => now,
    randomCode: () => "135790",
    rateLimit: vi.fn(async (name: string, max: number, windowMs: number, id: string) => {
      if (blocked.has(name)) return false
      const k = `${name}:${id}`
      const hits = (limits.get(k) ?? []).filter(t => t > now - windowMs)
      if (hits.length >= max) { limits.set(k, hits); return false }
      limits.set(k, [...hits, now])
      return true
    }),
  }
  const pv = createPayerVerify(deps)
  return { pv, deps, f, sent, blocked, advance: (ms: number) => { now += ms } }
}

describe("sendPayerOtp", () => {
  it("normalises the number, stores one code (purpose as the storefront checkout) and SMSes it", async () => {
    const m = make()
    expect(await m.pv.sendPayerOtp("+233 24 123 4567")).toEqual({ ok: true })
    expect(m.f.rows).toHaveLength(1)
    expect(m.f.rows[0]).toMatchObject({ phone: LOCAL, code: "135790", purpose: PAYER_OTP_PURPOSE, used: false })
    expect(PAYER_OTP_PURPOSE).toBe("signup")
    expect(m.sent).toEqual([[LOCAL, "135790"]])
  })

  it("rate-limited like the auth route: 3 codes per number per hour (any format of the number), then RATE_LIMITED", async () => {
    const m = make()
    for (const p of ["0241234567", "233241234567", "+233241234567"]) {
      expect(await m.pv.sendPayerOtp(p)).toEqual({ ok: true })
      m.advance(61 * 1000) // past the burst window
    }
    expect(await m.pv.sendPayerOtp(LOCAL)).toEqual({ ok: false, code: "RATE_LIMITED" })
    expect(m.f.rows).toHaveLength(3)
    expect(m.sent).toHaveLength(3)
    // an hour later the number may receive a code again
    m.advance(60 * 60 * 1000)
    expect(await m.pv.sendPayerOtp(LOCAL)).toEqual({ ok: true })
  })

  it("the auth route's burst cap (2 / min) applies per number", async () => {
    const m = make()
    expect(await m.pv.sendPayerOtp(LOCAL)).toEqual({ ok: true })
    expect(await m.pv.sendPayerOtp(LOCAL)).toEqual({ ok: true })
    expect(await m.pv.sendPayerOtp(LOCAL)).toEqual({ ok: false, code: "RATE_LIMITED" })
    expect(m.deps.rateLimit).toHaveBeenCalledWith(PAYER_OTP_BURST.name, 2, 60_000, `otps:${LOCAL}`)
    expect(m.f.rows).toHaveLength(2)
  })

  it("an existing hour's codes from the web flow count too (shared table)", async () => {
    const m = make([1, 2, 3].map(i => otpRow({ phone: LOCAL, code: `20000${i}` }, NOW)))
    expect(await m.pv.sendPayerOtp(LOCAL)).toEqual({ ok: false, code: "RATE_LIMITED" })
    expect(m.sent).toEqual([])
  })

  it("not a Ghana mobile number => SEND_FAILED, nothing stored or sent, no limiter slot", async () => {
    const m = make()
    expect(await m.pv.sendPayerOtp("12345")).toEqual({ ok: false, code: "SEND_FAILED" })
    expect(m.f.rows).toHaveLength(0)
    expect(m.deps.rateLimit).not.toHaveBeenCalled()
  })

  it("insert error => SEND_FAILED, no SMS", async () => {
    const m = make([], { insertError: true })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await m.pv.sendPayerOtp(LOCAL)).toEqual({ ok: false, code: "SEND_FAILED" })
    expect(m.sent).toEqual([])
    spy.mockRestore()
  })

  for (const [name, sms] of [["reports failure", { success: false }], ["is skipped (SMS disabled)", { success: true, skipped: true }], ["throws", new Error("down")]] as const) {
    it(`an SMS that ${name} => SEND_FAILED`, async () => {
      const m = make([], {}, sms)
      const spy = vi.spyOn(console, "error").mockImplementation(() => {})
      expect(await m.pv.sendPayerOtp(LOCAL)).toEqual({ ok: false, code: "SEND_FAILED" })
      spy.mockRestore()
    })
  }

  it("a count / DB throw => SEND_FAILED (never throws)", async () => {
    const m = make()
    ;(m.deps.db as any).from = () => { throw new Error("db down") }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await m.pv.sendPayerOtp(LOCAL)).toEqual({ ok: false, code: "SEND_FAILED" })
    spy.mockRestore()
  })
})

describe("verifyPayerOtp", () => {
  it("the right code succeeds once: row used=true (isPhoneOtpVerified then passes); a replay of it fails", async () => {
    const m = make()
    await m.pv.sendPayerOtp(LOCAL)
    expect(await m.pv.verifyPayerOtp("233241234567", " 135790 ")).toEqual({ ok: true, retry: false })
    expect(m.f.rows[0]).toMatchObject({ phone: LOCAL, used: true })
    expect(await m.pv.verifyPayerOtp(LOCAL, "135790")).toEqual({ ok: false, retry: false })
  })

  it("a wrong code => retry true (the live code stays usable)", async () => {
    const m = make()
    await m.pv.sendPayerOtp(LOCAL)
    expect(await m.pv.verifyPayerOtp(LOCAL, "000000")).toEqual({ ok: false, retry: true })
    expect(m.f.rows[0].used).toBe(false)
    expect(await m.pv.verifyPayerOtp(LOCAL, "135790")).toEqual({ ok: true, retry: false })
  })

  it("an expired code => retry false (a new code is needed)", async () => {
    const m = make()
    await m.pv.sendPayerOtp(LOCAL)
    m.advance(10 * 60 * 1000 + 1)
    expect(await m.pv.verifyPayerOtp(LOCAL, "135790")).toEqual({ ok: false, retry: false })
    expect(m.f.rows[0].used).toBe(false)
  })

  it("no code was ever sent => retry false", async () => {
    const m = make()
    expect(await m.pv.verifyPayerOtp(LOCAL, "135790")).toEqual({ ok: false, retry: false })
  })

  it("not 6 digits => retry true, no DB call, no limiter slot", async () => {
    const m = make()
    for (const c of ["", "12345", "1234567", "abcdef"]) expect(await m.pv.verifyPayerOtp(LOCAL, c)).toEqual({ ok: false, retry: true })
    expect(m.f.rpcCalls).toHaveLength(0)
    expect(m.deps.rateLimit).not.toHaveBeenCalled()
  })

  it("not a Ghana mobile number => not ok, no retry", async () => {
    const m = make()
    expect(await m.pv.verifyPayerOtp("12345", "135790")).toEqual({ ok: false, retry: false })
  })

  it("shares the verify route's per-number Upstash bucket (verify_phone_otp_phone / otpv:<digits>); blocked => no retry", async () => {
    const m = make([otpRow({ phone: LOCAL, code: "135790" }, NOW)])
    m.blocked.add("verify_phone_otp_phone")
    expect(await m.pv.verifyPayerOtp(LOCAL, "135790")).toEqual({ ok: false, retry: false })
    expect(m.deps.rateLimit).toHaveBeenCalledWith("verify_phone_otp_phone", 6, 600_000, `otpv:${LOCAL}`)
    expect(m.f.rows[0].used).toBe(false)
  })

  it("the DB attempt cap (> 6) => no retry, even for the right code", async () => {
    const m = make([otpRow({ phone: LOCAL, code: "135790", attempts: 6 }, NOW)])
    expect(await m.pv.verifyPayerOtp(LOCAL, "135790")).toEqual({ ok: false, retry: false })
    expect(m.f.rows[0].used).toBe(false)
  })

  it("seven wrong guesses lock the code (DB counter) even when Upstash lets them through", async () => {
    const m = make([otpRow({ phone: LOCAL, code: "135790" }, NOW)])
    m.deps.rateLimit = vi.fn(async () => true) // Upstash failing open
    const pv = createPayerVerify(m.deps)
    for (let i = 0; i < 6; i++) expect((await pv.verifyPayerOtp(LOCAL, "000000")).retry).toBe(true)
    expect(await pv.verifyPayerOtp(LOCAL, "135790")).toEqual({ ok: false, retry: false })
  })

  it("the DB attempt counter unavailable => fail closed, retry true (nothing verified)", async () => {
    const m = make([otpRow({ phone: LOCAL, code: "135790" }, NOW)], { rpc: "error" })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await m.pv.verifyPayerOtp(LOCAL, "135790")).toEqual({ ok: false, retry: true })
    expect(m.f.rows[0].used).toBe(false)
    spy.mockRestore()
  })

  it("a DB throw => not ok, retry true (never throws)", async () => {
    const m = make()
    ;(m.deps.db as any).rpc = async () => ({ data: 0, error: null })
    ;(m.deps.db as any).from = () => { throw new Error("db down") }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await m.pv.verifyPayerOtp(LOCAL, "135790")).toEqual({ ok: false, retry: true })
    spy.mockRestore()
  })
})
