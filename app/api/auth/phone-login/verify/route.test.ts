import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ verify: vi.fn(), limit: vi.fn() }))

vi.mock("../deps", () => ({ buildFlowDeps: () => ({}) }))
vi.mock("@/lib/phone-login/flow", () => ({ verifyPhoneLogin: (...a: unknown[]) => h.verify(...a) }))
vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: (...a: unknown[]) => h.limit(...a),
  getClientIdentifier: () => "ip:1.2.3.4",
}))

import { POST } from "./route"

const req = (body: unknown, cookie?: string) =>
  new NextRequest("http://localhost/api/auth/phone-login/verify", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { ...(cookie ? { cookie } : {}), "user-agent": "UA" },
  })

beforeEach(() => {
  h.verify.mockReset()
  h.limit.mockReset().mockResolvedValue({ allowed: true })
})

describe("POST /api/auth/phone-login/verify", () => {
  it("success sets dg_device (30 days) and clears dg_plc; passes browserSecret", async () => {
    h.verify.mockResolvedValue({ kind: "session", session: { access_token: "a", refresh_token: "r" }, deviceToken: "DEV" })
    const res = await POST(req({ challengeId: "cid", code: "123456" }, "dg_plc=SEC"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ session: { access_token: "a", refresh_token: "r" } })
    expect(h.verify.mock.calls[0][1]).toMatchObject({ challengeId: "cid", browserSecret: "SEC", code: "123456", userAgent: "UA" })
    const all = res.headers.getSetCookie().join("\n")
    expect(all).toMatch(/dg_device=DEV[^\n]*Max-Age=2592000/)
    expect(all).toMatch(/dg_device=DEV[^\n]*HttpOnly/i)
    expect(all).toMatch(/dg_plc=;[^\n]*Max-Age=0/)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("bad code format -> 400 with attemptsLeft null, flow not called", async () => {
    for (const code of ["12345", "1234567", "abcdef", 123456 as unknown]) {
      const res = await POST(req({ challengeId: "cid", code }, "dg_plc=SEC"))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "That code is not right.", attemptsLeft: null })
      expect(res.headers.get("Cache-Control")).toBe("no-store")
    }
    expect(h.verify).not.toHaveBeenCalled()
  })

  it("invalid -> 400 with attemptsLeft", async () => {
    h.verify.mockResolvedValue({ kind: "invalid", attemptsLeft: 3 })
    const res = await POST(req({ challengeId: "cid", code: "123456" }, "dg_plc=SEC"))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "That code is not right.", attemptsLeft: 3 })
  })

  it("restart -> 410 and clears dg_plc", async () => {
    h.verify.mockResolvedValue({ kind: "restart" })
    const res = await POST(req({ challengeId: "cid", code: "123456" }, "dg_plc=SEC"))
    expect(res.status).toBe(410)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(res.headers.getSetCookie().join("\n")).toMatch(/dg_plc=;[^\n]*Max-Age=0/)
  })

  it("bad challengeId -> 410", async () => {
    const res = await POST(req({ challengeId: "x".repeat(65), code: "123456" }))
    expect(res.status).toBe(410)
  })

  it("429 when limiter denies", async () => {
    h.limit.mockResolvedValueOnce({ allowed: false })
    const res = await POST(req({ challengeId: "cid", code: "123456" }))
    expect(res.status).toBe(429)
    expect(h.limit.mock.calls[0].slice(1)).toEqual(["phone_login_verify", 10, 900_000, undefined, { pgFallback: true }])
    expect(h.verify).not.toHaveBeenCalled()
  })

  it("flow throw -> 503 fixed body", async () => {
    h.verify.mockRejectedValue(new Error("db"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await POST(req({ challengeId: "cid", code: "123456" }, "dg_plc=SEC"))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "Phone sign-in is unavailable right now. Please use email." })
    spy.mockRestore()
  })
})
