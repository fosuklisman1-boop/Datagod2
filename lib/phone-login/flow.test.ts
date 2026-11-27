import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Account } from "./core"
import { sha256Hex, phoneHash, ipHash, phoneKey } from "./core"

process.env.PHONE_LOGIN_HASH_SECRET = "flow-test-secret-flow-test-secret-0123456789"

type Ev = { kind: string; f: Record<string, unknown> }
type Chal = {
  id: string; userId: string; browserSecretHash: string; otpPhone: string; attempts: number
  lastSentAt: Date; expiresAt: Date; consumedAt: Date | null
}

const st = vi.hoisted(() => ({
  accounts: new Map<string, unknown>(),
  failures: new Map<string, number>(),
  events: [] as Array<{ kind: string; f: Record<string, unknown> }>,
  challenges: new Map<string, unknown>(),
  devices: [] as Array<{ userId: string; tokenHash: string; id: string; uaLabel?: string }>,
  touched: [] as string[],
  distinctPhones: 0,
  lockouts: 0,
  passwordChanged: false,
  otpIssue: { ok: true } as { ok: boolean; reason?: string },
  otpCheck: "verified" as string,
  issued: [] as Array<{ phone: string; purpose: string }>,
  sendThrows: false,
  verifyCalls: 0,
  dummyCalls: 0,
  verifyResult: { access_token: "AT", refresh_token: "RT" } as unknown,
  verifyThrows: false,
  gate: null as Promise<void> | null,
  inflight: new Map<string, number>(),
  begun: 0,
  ended: 0,
  recordFailureCalls: 0,
  revokeThrows: false,
  mintThrows: false,
  trustThrows: false,
  otpSms: null as unknown,
  revoked: [] as string[],
  minted: [] as string[],
  calls: [] as unknown[],
}))

vi.mock("./store", () => ({
  findAccount: vi.fn(async (_db: unknown, sig: string) =>
    st.accounts.get(sig) ?? { matchCount: 0, verifiedCount: 0, userId: null, email: null, phone: null, phoneVerified: false, isSuspended: false }),
  // Models the RPC: in-flight attempts count toward the cap together with recorded failures.
  beginAttempt: vi.fn(async (_db: unknown, h: string) => {
    if ((st.failures.get(h) ?? 0) + (st.inflight.get(h) ?? 0) >= 5) return false
    st.inflight.set(h, (st.inflight.get(h) ?? 0) + 1)
    st.begun++
    return true
  }),
  endAttempt: vi.fn(async (_db: unknown, h: string) => {
    st.inflight.set(h, Math.max(0, (st.inflight.get(h) ?? 0) - 1))
    st.ended++
  }),
  recordFailure: vi.fn(async (_db: unknown, h: string) => {
    st.recordFailureCalls++
    const n = (st.failures.get(h) ?? 0) + 1
    st.failures.set(h, n)
    st.inflight.set(h, Math.max(0, (st.inflight.get(h) ?? 0) - 1))
    return { locked: n >= 5 }
  }),
  recordEvent: vi.fn(async (_db: unknown, kind: string, f: Record<string, unknown>) => { st.events.push({ kind, f }) }),
  countDistinctPhonesFromIp: vi.fn(async () => st.distinctPhones),
  countEvents: vi.fn(async () => st.lockouts),
  hadPasswordChangeSince: vi.fn(async () => st.passwordChanged),
  createChallenge: vi.fn(async (_db: unknown, c: { id: string; userId: string; browserSecretHash: string; otpPhone: string; now: Date }) => {
    st.calls.push({ createChallenge: { ...c, browserSecretHash: "H" } })
    st.challenges.set(c.id, {
      id: c.id, userId: c.userId, browserSecretHash: c.browserSecretHash, otpPhone: c.otpPhone,
      attempts: 0, lastSentAt: c.now, expiresAt: new Date(c.now.getTime() + 600_000), consumedAt: null,
    })
  }),
  getChallenge: vi.fn(async (_db: unknown, id: string) => st.challenges.get(id) ?? null),
  bumpChallengeAttempt: vi.fn(async (_db: unknown, id: string) => {
    const c = st.challenges.get(id) as { attempts: number }
    c.attempts += 1
    return c.attempts
  }),
  consumeChallenge: vi.fn(async (_db: unknown, id: string, now: Date) => {
    const c = st.challenges.get(id) as { consumedAt: Date | null; expiresAt: Date }
    if (c.consumedAt || c.expiresAt <= now) return false
    c.consumedAt = now
    return true
  }),
  killChallenge: vi.fn(async (_db: unknown, id: string) => {
    const c = st.challenges.get(id) as { expiresAt: Date } | undefined
    if (c) c.expiresAt = new Date(0)
  }),
  touchChallengeSent: vi.fn(async (_db: unknown, id: string, now: Date) => {
    ;(st.challenges.get(id) as { lastSentAt: Date }).lastSentAt = now
  }),
  findTrustedDevice: vi.fn(async (_db: unknown, tokenHash: string, userId: string) => {
    const d = st.devices.find((x) => x.tokenHash === tokenHash && x.userId === userId)
    return d ? { id: d.id } : null
  }),
  trustDevice: vi.fn(async (_db: unknown, d: { userId: string; tokenHash: string; uaLabel: string }) => {
    if (st.trustThrows) throw new Error("db down")
    st.devices.push({ userId: d.userId, tokenHash: d.tokenHash, id: "dev" + st.devices.length, uaLabel: d.uaLabel })
  }),
  touchDevice: vi.fn(async (_db: unknown, id: string) => { st.touched.push(id) }),
}))

vi.mock("./session", () => ({
  verifyPassword: vi.fn(async () => {
    st.verifyCalls++
    if (st.gate) await st.gate
    if (st.verifyThrows) throw new Error("auth unavailable")
    return st.verifyResult
  }),
  dummyPasswordCheck: vi.fn(async () => { st.dummyCalls++ }),
  revokeSessionLocal: vi.fn(async (_d: unknown, token: string) => {
    if (st.revokeThrows) throw new Error("session revoke failed")
    st.revoked.push(token)
  }),
  mintSession: vi.fn(async (_d: unknown, email: string) => {
    if (st.mintThrows) throw new Error("session mint failed")
    st.minted.push(email)
    return { access_token: "MAT", refresh_token: "MRT" }
  }),
}))

vi.mock("@/lib/phone-otp", () => ({
  issuePhoneOtp: vi.fn(async (d: { sendCode: (p: string, c: string) => Promise<unknown> }, phone: string, purpose: string) => {
    st.issued.push({ phone, purpose })
    if (!st.otpIssue.ok) return st.otpIssue
    await d.sendCode(phone, "SECRETCODE")
    return { ok: true, sms: st.otpSms }
  }),
  defaultPhoneOtpCode: () => "654321",
  checkPhoneOtp: vi.fn(async () => st.otpCheck),
}))

import { startPhoneLogin, verifyPhoneLogin, resendPhoneLoginCode, type FlowDeps } from "./flow"

const NOW = new Date("2026-11-27T12:00:00Z")
const PW = "Sup3rSecretPw!"
const TYPED = "0241234567"
const REG_PHONE = "0551112223"
const EMAIL = "victim@example.com"

const good: Account = {
  matchCount: 1, verifiedCount: 1, userId: "user-A", email: EMAIL, phone: REG_PHONE, phoneVerified: true, isSuspended: false,
}

let sent: Array<{ phone: string; code: string }>
let alerts: Array<Record<string, unknown>>
let settings: { enabled: boolean; newDeviceCode: boolean }
let now: Date
let emails: Record<string, string | null>

function deps(): FlowDeps {
  return {
    db: {} as never,
    session: {} as never,
    settings: async () => settings,
    sendCode: async (phone, code) => {
      if (st.sendThrows) throw new Error("sms down")
      sent.push({ phone, code })
    },
    alert: (async (o: Record<string, unknown>) => { alerts.push(o); return true }) as never,
    now: () => now,
    emailForUser: async (id) => emails[id] ?? null,
  }
}

const start = (over: Partial<{ phone: string; password: string; ip: string; deviceToken: string | null }> = {}) =>
  startPhoneLogin(deps(), { phone: TYPED, password: PW, ip: "1.2.3.4", deviceToken: null, ...over })

function setAccount(a: Account, phone = TYPED) {
  st.accounts.set(phoneKey(phone)!.sig, a)
}

beforeEach(() => {
  st.accounts.clear(); st.failures.clear(); st.events.length = 0; st.challenges.clear(); st.devices.length = 0
  st.touched.length = 0; st.distinctPhones = 0; st.lockouts = 0; st.passwordChanged = false
  st.otpIssue = { ok: true }; st.otpCheck = "verified"; st.issued.length = 0; st.sendThrows = false
  st.verifyCalls = 0; st.dummyCalls = 0; st.verifyResult = { access_token: "AT", refresh_token: "RT" }
  st.verifyThrows = false; st.gate = null; st.inflight.clear(); st.begun = 0; st.ended = 0; st.recordFailureCalls = 0
  st.revokeThrows = false; st.mintThrows = false; st.trustThrows = false; st.otpSms = null
  st.revoked.length = 0; st.minted.length = 0; st.calls.length = 0
  sent = []; alerts = []; settings = { enabled: true, newDeviceCode: true }; now = new Date(NOW)
  emails = { "user-A": EMAIL, "user-B": "b@example.com" }
  setAccount(good)
})

describe("startPhoneLogin step 1", () => {
  it("returns disabled when the feature is off", async () => {
    settings.enabled = false
    expect(await start()).toEqual({ kind: "disabled" })
    expect(st.verifyCalls + st.dummyCalls).toBe(0)
  })

  const cases: Array<[string, () => Promise<unknown>]> = [
    ["unknown number", () => { st.accounts.clear(); return start() }],
    ["shared number", () => { setAccount({ ...good, matchCount: 2, verifiedCount: 2 }); return start() }],
    ["unverified", () => { setAccount({ ...good, verifiedCount: 0, phoneVerified: false }); return start() }],
    ["suspended", () => { setAccount({ ...good, isSuspended: true }); return start() }],
    ["wrong password", () => { st.verifyResult = null; return start() }],
    ["locked", () => { st.failures.set(phoneHash(phoneKey(TYPED)!.sig), 5); return start() }],
    ["unparseable phone", () => start({ phone: "abc" })],
  ]
  it.each(cases)("all step-1 failures are indistinguishable: %s", async (_n, run) => {
    expect(await run()).toEqual({ kind: "fail" })
    expect(st.verifyCalls + st.dummyCalls).toBe(1)
    expect(st.minted.length).toBe(0)
    expect(sent.length).toBe(0)
  })

  it("lockout counts across formats", async () => {
    st.verifyResult = null
    for (const f of ["024 123 4567", "+233241234567", "233241234567", "241234567"]) {
      expect(await start({ phone: f })).toEqual({ kind: "fail" })
    }
    expect(await start({ phone: "0241234567" })).toEqual({ kind: "fail" }) // 5th failure locks
    st.verifyResult = { access_token: "AT", refresh_token: "RT" }
    st.verifyCalls = 0
    expect(await start({ phone: "241234567" })).toEqual({ kind: "fail" }) // right password but locked
    expect(st.verifyCalls).toBe(0)
  })
})

describe("startPhoneLogin success paths", () => {
  it("trusted device returns a session and sends no SMS", async () => {
    st.devices.push({ userId: "user-A", tokenHash: sha256Hex("DEVTOK"), id: "d1" })
    const r = await start({ deviceToken: "DEVTOK" })
    expect(r.kind).toBe("session")
    expect(sent.length).toBe(0)
    expect(st.touched).toEqual(["d1"])
    expect(st.events.some((e) => e.kind === "login_ok")).toBe(true)
  })

  it("device trusted for user A is untrusted for user B", async () => {
    st.devices.push({ userId: "user-A", tokenHash: sha256Hex("DEVTOK"), id: "d1" })
    setAccount({ ...good, userId: "user-B", email: "b@example.com" })
    const r = await start({ deviceToken: "DEVTOK" })
    expect(r.kind).toBe("challenge")
    expect(st.touched.length).toBe(0)
  })

  it("untrusted device revokes with local, sends to the registered number, returns no session", async () => {
    const r = await start()
    expect(r.kind).toBe("challenge")
    if (r.kind !== "challenge") return
    expect(st.revoked).toEqual(["AT"])
    expect(sent.length).toBe(1)
    expect(sent[0].phone).toBe(REG_PHONE)
    expect(sent[0].phone).not.toBe(TYPED)
    expect(r.maskedPhone).toBe("055 *** **23")
    expect(r.browserSecret.length).toBeGreaterThan(20)
    expect(st.minted.length).toBe(0)
    expect(JSON.stringify(r)).not.toContain("AT")
    expect(st.issued[0].purpose).toBe("phone_login")
  })

  it("newDeviceCode off returns a session with no SMS", async () => {
    settings.newDeviceCode = false
    const r = await start()
    expect(r.kind).toBe("session")
    expect(sent.length).toBe(0)
    expect(st.revoked.length).toBe(0)
  })

  it("send failure leaves no live challenge (thrown send)", async () => {
    st.sendThrows = true
    expect(await start()).toEqual({ kind: "send_failed" })
    for (const c of st.challenges.values()) expect((c as Chal).expiresAt.getTime()).toBeLessThanOrEqual(0)
  })

  it("send failure leaves no live challenge (rate limited)", async () => {
    st.otpIssue = { ok: false, reason: "PHONE_LIMIT" }
    expect(await start()).toEqual({ kind: "send_failed" })
    expect(st.challenges.size).toBe(1)
    for (const c of st.challenges.values()) expect((c as Chal).expiresAt.getTime()).toBeLessThanOrEqual(0)
  })
})

async function makeChallenge() {
  const r = await start()
  if (r.kind !== "challenge") throw new Error("expected challenge")
  return r
}
const verify = (r: { challengeId: string; browserSecret: string }, over: Partial<{ browserSecret: string | null; code: string }> = {}) =>
  verifyPhoneLogin(deps(), {
    challengeId: r.challengeId, browserSecret: r.browserSecret, code: "123456", ip: "1.2.3.4", userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120 Safari/537",
    ...over,
  })

describe("verifyPhoneLogin", () => {
  it("success trusts the device, returns its token, mints for the challenge user's email", async () => {
    const c = await makeChallenge()
    const r = await verify(c)
    expect(r.kind).toBe("session")
    if (r.kind !== "session") return
    expect(st.minted).toEqual([EMAIL])
    expect(st.devices.length).toBe(1)
    expect(st.devices[0].tokenHash).toBe(sha256Hex(r.deviceToken))
    expect(st.devices[0].userId).toBe("user-A")
    expect(st.events.some((e) => e.kind === "challenge_passed")).toBe(true)
  })

  it("wrong browser secret -> restart", async () => {
    const c = await makeChallenge()
    expect(await verify(c, { browserSecret: "nope" })).toEqual({ kind: "restart" })
    expect(await verify(c, { browserSecret: null })).toEqual({ kind: "restart" })
    expect(st.minted.length).toBe(0)
  })

  it("unknown challenge -> restart", async () => {
    expect(await verify({ challengeId: "x", browserSecret: "y" })).toEqual({ kind: "restart" })
  })

  it("expired -> restart", async () => {
    const c = await makeChallenge()
    now = new Date(NOW.getTime() + 11 * 60_000)
    expect(await verify(c)).toEqual({ kind: "restart" })
    expect(st.minted.length).toBe(0)
  })

  it("wrong code reports attempts left; 5 wrong codes -> restart and challenge dead", async () => {
    const c = await makeChallenge()
    st.otpCheck = "invalid"
    for (let i = 1; i <= 4; i++) {
      expect(await verify(c)).toEqual({ kind: "invalid", attemptsLeft: 5 - i })
    }
    expect(await verify(c)).toEqual({ kind: "restart" })
    st.otpCheck = "verified"
    expect(await verify(c)).toEqual({ kind: "restart" })
    expect(st.minted.length).toBe(0)
  })

  it("too_many_attempts kills the challenge", async () => {
    const c = await makeChallenge()
    st.otpCheck = "too_many_attempts"
    expect(await verify(c)).toEqual({ kind: "restart" })
    st.otpCheck = "verified"
    expect(await verify(c)).toEqual({ kind: "restart" })
  })

  it("unavailable fails closed without bumping", async () => {
    const c = await makeChallenge()
    st.otpCheck = "unavailable"
    expect(await verify(c)).toEqual({ kind: "invalid", attemptsLeft: 5 })
    expect((st.challenges.get(c.challengeId) as Chal).attempts).toBe(0)
    expect(st.minted.length).toBe(0)
  })

  it("second verify after success is restart", async () => {
    const c = await makeChallenge()
    expect((await verify(c)).kind).toBe("session")
    expect(await verify(c)).toEqual({ kind: "restart" })
    expect(st.minted.length).toBe(1)
  })

  it("missing email for the user -> restart, no session", async () => {
    const c = await makeChallenge()
    emails["user-A"] = null
    expect(await verify(c)).toEqual({ kind: "restart" })
    expect(st.minted.length).toBe(0)
  })

  it("after-reset info alert", async () => {
    const c = await makeChallenge()
    st.passwordChanged = true
    await verify(c)
    const a = alerts.find((x) => x.category === "phone_login_after_reset")
    expect(a).toBeTruthy()
    expect(a!.severity).toBe("info")
  })
})

describe("alerts", () => {
  it("stuffing alert fires at 21 distinct phones from one IP", async () => {
    st.verifyResult = null
    st.distinctPhones = 20
    await start()
    expect(alerts.find((a) => a.category === "phone_login_stuffing")).toBeUndefined()
    st.distinctPhones = 21
    await start()
    const a = alerts.find((x) => x.category === "phone_login_stuffing")!
    expect(a.severity).toBe("high")
    expect(a.dedupeKey).toBe(ipHash("1.2.3.4"))
    expect(a.dedupeWindowMin).toBe(60)
  })

  it("lockout alert at 11 lockouts", async () => {
    st.verifyResult = null
    st.lockouts = 10
    await start()
    expect(alerts.find((a) => a.category === "phone_login_lockouts")).toBeUndefined()
    st.lockouts = 11
    await start()
    const a = alerts.find((x) => x.category === "phone_login_lockouts")!
    expect(a.severity).toBe("high")
    expect(a.dedupeKey).toBe("sitewide")
    expect(a.dedupeWindowMin).toBe(60)
  })
})

describe("resendPhoneLoginCode", () => {
  it("resend within 60 s -> wait", async () => {
    const c = await makeChallenge()
    sent.length = 0
    now = new Date(NOW.getTime() + 20_000)
    const r = await resendPhoneLoginCode(deps(), c)
    expect(r).toEqual({ kind: "wait", seconds: 40 })
    expect(sent.length).toBe(0)
  })

  it("resend after 60 s sends to the challenge phone", async () => {
    const c = await makeChallenge()
    sent.length = 0
    now = new Date(NOW.getTime() + 61_000)
    expect(await resendPhoneLoginCode(deps(), c)).toEqual({ kind: "sent" })
    expect(sent[0].phone).toBe(REG_PHONE)
    expect((st.challenges.get(c.challengeId) as Chal).lastSentAt).toEqual(now)
  })

  it("resend rate limited -> wait 3600", async () => {
    const c = await makeChallenge()
    now = new Date(NOW.getTime() + 61_000)
    st.otpIssue = { ok: false, reason: "PHONE_LIMIT" }
    expect(await resendPhoneLoginCode(deps(), c)).toEqual({ kind: "wait", seconds: 3600 })
  })

  it("resend send failure -> challenge killed + send_failed", async () => {
    const c = await makeChallenge()
    now = new Date(NOW.getTime() + 61_000)
    st.sendThrows = true
    expect(await resendPhoneLoginCode(deps(), c)).toEqual({ kind: "send_failed" })
    st.sendThrows = false
    expect(await resendPhoneLoginCode(deps(), c)).toEqual({ kind: "restart" })
  })

  it("bad secret / expired -> restart", async () => {
    const c = await makeChallenge()
    expect(await resendPhoneLoginCode(deps(), { ...c, browserSecret: "bad" })).toEqual({ kind: "restart" })
    now = new Date(NOW.getTime() + 11 * 60_000)
    expect(await resendPhoneLoginCode(deps(), c)).toEqual({ kind: "restart" })
  })
})

describe("I3: auth-service errors are not wrong passwords", () => {
  it("verifyPassword throwing propagates and records NO failure (route answers 503)", async () => {
    st.verifyThrows = true
    await expect(start()).rejects.toThrow()
    expect(st.recordFailureCalls).toBe(0)
    expect(st.failures.size).toBe(0)
    expect(st.minted.length + sent.length).toBe(0)
  })

  it("a real wrong password (null) is the generic fail and records a failure", async () => {
    st.verifyResult = null
    expect(await start()).toEqual({ kind: "fail" })
    expect(st.recordFailureCalls).toBe(1)
  })
})

describe("I4: parallel attempts cannot bypass the per-phone lockout", () => {
  it("6 concurrent starts on one number run at most 5 password checks", async () => {
    st.verifyResult = null
    let release!: () => void
    st.gate = new Promise<void>((r) => { release = r })
    const all = Promise.all(Array.from({ length: 6 }, () => start()))
    await new Promise((r) => setTimeout(r, 0))
    release()
    const results = await all
    expect(results.every((r) => r.kind === "fail")).toBe(true)
    expect(st.verifyCalls).toBeLessThanOrEqual(5)
    expect(st.dummyCalls).toBeGreaterThanOrEqual(1)
  })

  it("a correct password releases its slot, whatever happens next", async () => {
    expect((await start()).kind).toBe("challenge")
    expect(st.ended).toBe(1)
    expect(st.inflight.get(phoneHash(phoneKey(TYPED)!.sig)) ?? 0).toBe(0)
    settings.newDeviceCode = false
    expect((await start()).kind).toBe("session")
    expect(st.ended).toBe(2)
    st.revokeThrows = true
    settings.newDeviceCode = true
    await expect(start()).rejects.toThrow()
    expect(st.ended).toBe(3)
  })

  it("a wrong password does not double-count (the failure releases the slot itself)", async () => {
    st.verifyResult = null
    await start()
    expect(st.ended).toBe(0)
    expect(st.inflight.get(phoneHash(phoneKey(TYPED)!.sig)) ?? 0).toBe(0)
  })
})

describe("M1-M5 verify/resend/start hardening", () => {
  it("M1: a null email burns nothing silently: the challenge is killed", async () => {
    const c = await makeChallenge()
    emails["user-A"] = null
    expect(await verify(c)).toEqual({ kind: "restart" })
    emails["user-A"] = EMAIL
    expect(await verify(c)).toEqual({ kind: "restart" })
    expect(st.minted.length).toBe(0)
  })

  it("M2a: revokeSessionLocal throwing propagates; no SMS, no session", async () => {
    st.revokeThrows = true
    await expect(start()).rejects.toThrow("session revoke failed")
    expect(sent.length).toBe(0)
    expect(st.challenges.size).toBe(0)
  })

  it("M2b: mintSession throwing after consume propagates and returns no session", async () => {
    const c = await makeChallenge()
    st.mintThrows = true
    await expect(verify(c)).rejects.toThrow("session mint failed")
    expect(st.devices.length).toBe(0)
  })

  it("M2b: trustDevice throwing after consume propagates and returns no session", async () => {
    const c = await makeChallenge()
    st.trustThrows = true
    await expect(verify(c)).rejects.toThrow("db down")
  })

  it("M3: a failed SMS delivery reported as sms.success=false is send_failed and the challenge is dead", async () => {
    st.otpSms = { success: false, error: "provider down" }
    expect(await start()).toEqual({ kind: "send_failed" })
    for (const c of st.challenges.values()) expect((c as Chal).expiresAt.getTime()).toBeLessThanOrEqual(0)
  })

  it("M3: resend with sms.success=false is send_failed and kills the challenge", async () => {
    const c = await makeChallenge()
    now = new Date(NOW.getTime() + 61_000)
    st.otpSms = { success: false }
    expect(await resendPhoneLoginCode(deps(), c)).toEqual({ kind: "send_failed" })
    st.otpSms = null
    expect(await resendPhoneLoginCode(deps(), c)).toEqual({ kind: "restart" })
  })

  it("M3: a successful provider result still counts as sent", async () => {
    st.otpSms = { success: true, messageId: "m1" }
    expect((await start()).kind).toBe("challenge")
  })

  it("M4: switching the feature off stops open challenges (verify and resend -> restart)", async () => {
    const c = await makeChallenge()
    now = new Date(NOW.getTime() + 61_000)
    settings.enabled = false
    expect(await verify(c)).toEqual({ kind: "restart" })
    expect(await resendPhoneLoginCode(deps(), c)).toEqual({ kind: "restart" })
    expect(st.minted.length).toBe(0)
    expect(sent.length).toBe(1)
  })

  it("M5: an unchallenged login (code switched off) is labelled login_unchallenged, not login_ok", async () => {
    settings.newDeviceCode = false
    expect((await start()).kind).toBe("session")
    expect(st.events.some((e) => e.kind === "login_unchallenged")).toBe(true)
    expect(st.events.some((e) => e.kind === "login_ok")).toBe(false)
  })

  it("M5: a trusted-device login stays login_ok even when the code is off", async () => {
    settings.newDeviceCode = false
    st.devices.push({ userId: "user-A", tokenHash: sha256Hex("DEVTOK"), id: "d1" })
    await start({ deviceToken: "DEVTOK" })
    expect(st.events.map((e) => e.kind)).toContain("login_ok")
  })
})

describe("no sensitive values in alerts or events", () => {
  it("never carries phone, code, password or email", async () => {
    st.verifyResult = null
    st.distinctPhones = 21; st.lockouts = 11
    await start()
    st.verifyResult = { access_token: "AT", refresh_token: "RT" }
    st.distinctPhones = 0; st.lockouts = 0
    const c = await makeChallenge()
    st.passwordChanged = true
    await verify(c)
    const blob = JSON.stringify({ alerts, events: st.events })
    for (const bad of [PW, TYPED, "241234567", REG_PHONE, "551112223", EMAIL, "SECRETCODE", "123456", "1.2.3.4"]) {
      expect(blob).not.toContain(bad)
    }
    expect(alerts.length).toBeGreaterThan(0)
  })
})

export type _Unused = Ev
