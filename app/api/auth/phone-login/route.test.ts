import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  start: vi.fn(),
  settings: vi.fn(),
  limit: vi.fn(),
}))

vi.mock("./deps", () => ({ buildFlowDeps: () => ({ settings: h.settings }) }))
vi.mock("@/lib/phone-login/flow", () => ({ startPhoneLogin: (...a: unknown[]) => h.start(...a) }))
vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: (...a: unknown[]) => h.limit(...a),
  getClientIdentifier: () => "ip:1.2.3.4",
}))

import { GET, POST } from "./route"
import { GENERIC_LOGIN_ERROR } from "@/lib/phone-login/core"
import { _setTimingDepsForTest } from "./http"

const SECRET = "route-test-secret-route-test-secret-0123456789"
process.env.PHONE_LOGIN_HASH_SECRET = SECRET

// Fake clock: sleeping advances time instantly, so the timing floor is observable without waiting.
let clock = 0
let slept: number[] = []
const fakeTiming = {
  now: () => clock,
  sleep: async (ms: number) => {
    slept.push(ms)
    clock += ms
  },
  random: () => 0.5,
}

const req = (body: unknown, cookie?: string) =>
  new NextRequest("http://localhost/api/auth/phone-login", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: cookie ? { cookie } : {},
  })

beforeEach(() => {
  process.env.PHONE_LOGIN_HASH_SECRET = SECRET
  clock = 5_000
  slept = []
  _setTimingDepsForTest(fakeTiming)
  h.start.mockReset()
  h.settings.mockReset()
  h.limit.mockReset().mockResolvedValue({ allowed: true })
})

describe("GET /api/auth/phone-login", () => {
  it("returns only { enabled } with no-store", async () => {
    h.settings.mockResolvedValue({ enabled: true, newDeviceCode: true })
    const res = await GET()
    expect(await res.json()).toEqual({ enabled: true })
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })
  it("503 when settings throw", async () => {
    h.settings.mockRejectedValue(new Error("db"))
    const res = await GET()
    expect(res.status).toBe(503)
  })
  it("reports enabled:false when the hash secret is missing, even if the setting is on (fail closed)", async () => {
    h.settings.mockResolvedValue({ enabled: true, newDeviceCode: true })
    delete process.env.PHONE_LOGIN_HASH_SECRET
    expect(await (await GET()).json()).toEqual({ enabled: false })
    process.env.PHONE_LOGIN_HASH_SECRET = "short"
    expect(await (await GET()).json()).toEqual({ enabled: false })
  })
})

describe("POST /api/auth/phone-login hash secret (M6)", () => {
  it("missing or short secret -> 503 fixed body, flow never called", async () => {
    for (const v of [undefined, "x".repeat(31)]) {
      if (v === undefined) delete process.env.PHONE_LOGIN_HASH_SECRET
      else process.env.PHONE_LOGIN_HASH_SECRET = v
      const res = await POST(req({ phone: "0241234567", password: "pw" }))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "Phone sign-in is unavailable right now. Please use email." })
    }
    expect(h.start).not.toHaveBeenCalled()
  })
})

describe("POST /api/auth/phone-login timing floor (I2)", () => {
  const good = { phone: "0241234567", password: "pw" }
  const cases: Array<[string, () => Promise<Response>]> = [
    ["fail", () => { h.start.mockResolvedValue({ kind: "fail" }); return POST(req(good)) }],
    ["session", () => { h.start.mockResolvedValue({ kind: "session", session: { access_token: "a", refresh_token: "r" } }); return POST(req(good)) }],
    ["challenge", () => { h.start.mockResolvedValue({ kind: "challenge", challengeId: "c", browserSecret: "s", maskedPhone: "m" }); return POST(req(good)) }],
    ["disabled 404", () => { h.start.mockResolvedValue({ kind: "disabled" }); return POST(req(good)) }],
    ["send_failed 503", () => { h.start.mockResolvedValue({ kind: "send_failed" }); return POST(req(good)) }],
    ["flow throws 503", () => { h.start.mockRejectedValue(new Error("x")); vi.spyOn(console, "error").mockImplementation(() => {}); return POST(req(good)) }],
    ["429 limiter", () => { h.limit.mockResolvedValue({ allowed: false }); return POST(req(good)) }],
    ["bad body", () => POST(req("not json"))],
    ["secret missing 503", () => { delete process.env.PHONE_LOGIN_HASH_SECRET; return POST(req(good)) }],
  ]
  it.each(cases)("every outcome waits the 700 ms floor (+ jitter): %s", async (_n, run) => {
    const t0 = clock
    await run()
    expect(clock - t0).toBeGreaterThanOrEqual(700)
    expect(clock - t0).toBeLessThan(800)
  })

  it("a slow flow (real bcrypt) is not padded further once past the floor", async () => {
    h.start.mockImplementation(async () => { clock += 900; return { kind: "fail" } })
    const t0 = clock
    await POST(req(good))
    expect(clock - t0).toBe(900)
    expect(slept).toEqual([])
  })
})

describe("POST /api/auth/phone-login", () => {
  it("generic 401 body is byte-identical for fail and bad bodies", async () => {
    h.start.mockResolvedValue({ kind: "fail" })
    const bodies: string[] = []
    for (const b of [
      { phone: "0241234567", password: "x" },
      "not json",
      { phone: 5, password: "x" },
      { phone: "0".repeat(21), password: "x" },
      { phone: "0241234567", password: "p".repeat(201) },
    ]) {
      const res = await POST(req(b))
      expect(res.status).toBe(401)
      expect(res.headers.get("Cache-Control")).toBe("no-store")
      bodies.push(await res.text())
    }
    expect(new Set(bodies).size).toBe(1)
    expect(bodies[0]).toBe(JSON.stringify({ error: GENERIC_LOGIN_ERROR }))
  })

  it("session result returns the session, no-store", async () => {
    h.start.mockResolvedValue({ kind: "session", session: { access_token: "a", refresh_token: "r" } })
    const res = await POST(req({ phone: "0241234567", password: "pw" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ session: { access_token: "a", refresh_token: "r" } })
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("challenge: no token in body, dg_plc httpOnly, secret not in body", async () => {
    h.start.mockResolvedValue({ kind: "challenge", challengeId: "cid", browserSecret: "SECRET", maskedPhone: "024 *** **67" })
    const res = await POST(req({ phone: "0241234567", password: "pw" }))
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(JSON.parse(text)).toEqual({ challenge: { id: "cid", maskedPhone: "024 *** **67" } })
    expect(text).not.toContain("access_token")
    expect(text).not.toContain("SECRET")
    expect(res.cookies.get("dg_plc")!.value).toBe("SECRET")
    const raw = res.headers.get("set-cookie")!
    expect(raw).toMatch(/HttpOnly/i)
    expect(raw).toMatch(/Secure/i)
    expect(raw).toMatch(/SameSite=lax/i)
    expect(raw).toMatch(/Max-Age=600/)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("passes dg_device cookie as deviceToken", async () => {
    h.start.mockResolvedValue({ kind: "fail" })
    await POST(req({ phone: "0241234567", password: "pw" }, "dg_device=TOK"))
    expect(h.start.mock.calls[0][1]).toMatchObject({ phone: "0241234567", password: "pw", deviceToken: "TOK" })
    await POST(req({ phone: "0241234567", password: "pw" }))
    expect(h.start.mock.calls[1][1].deviceToken).toBeNull()
  })

  it("disabled -> 404, send_failed -> 503", async () => {
    h.start.mockResolvedValueOnce({ kind: "disabled" })
    const a = await POST(req({ phone: "0241234567", password: "pw" }))
    expect(a.status).toBe(404)
    expect(a.headers.get("Cache-Control")).toBe("no-store")
    h.start.mockResolvedValueOnce({ kind: "send_failed" })
    const b = await POST(req({ phone: "0241234567", password: "pw" }))
    expect(b.status).toBe(503)
  })

  it("429 when the limiter denies, and when degraded without fallback; flow not called", async () => {
    h.limit.mockResolvedValueOnce({ allowed: false })
    const a = await POST(req({ phone: "0241234567", password: "pw" }))
    expect(a.status).toBe(429)
    expect(await a.json()).toEqual({ error: "Too many attempts. Please try again later." })
    h.limit.mockResolvedValueOnce({ allowed: true, degraded: true })
    const b = await POST(req({ phone: "0241234567", password: "pw" }))
    expect(b.status).toBe(429)
    expect(h.start).not.toHaveBeenCalled()
    expect(h.limit.mock.calls[0].slice(1)).toEqual(["phone_login", 10, 900_000, undefined, { pgFallback: true }])
  })

  it("flow throwing -> 503 fixed body, never 401, no leak", async () => {
    h.start.mockRejectedValue(new Error("secret db detail 0241234567"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await POST(req({ phone: "0241234567", password: "pw" }))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "Phone sign-in is unavailable right now. Please use email." })
    expect(JSON.stringify(spy.mock.calls)).not.toContain("0241234567")
    spy.mockRestore()
  })
})
