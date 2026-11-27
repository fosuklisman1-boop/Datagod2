import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ resend: vi.fn(), limit: vi.fn() }))

vi.mock("../deps", () => ({ buildFlowDeps: () => ({}) }))
vi.mock("@/lib/phone-login/flow", () => ({ resendPhoneLoginCode: (...a: unknown[]) => h.resend(...a) }))
vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: (...a: unknown[]) => h.limit(...a),
  getClientIdentifier: () => "ip:1.2.3.4",
}))

import { POST } from "./route"

const req = (body: unknown, cookie?: string) =>
  new NextRequest("http://localhost/api/auth/phone-login/resend", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: cookie ? { cookie } : {},
  })

beforeEach(() => {
  h.resend.mockReset()
  h.limit.mockReset().mockResolvedValue({ allowed: true })
})

describe("POST /api/auth/phone-login/resend", () => {
  it("sent -> 200 { sent: true }, passes browserSecret, no-store", async () => {
    h.resend.mockResolvedValue({ kind: "sent" })
    const res = await POST(req({ challengeId: "cid" }, "dg_plc=SEC"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sent: true })
    expect(h.resend.mock.calls[0][1]).toEqual({ challengeId: "cid", browserSecret: "SEC" })
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })
  it("wait -> 429 with seconds", async () => {
    h.resend.mockResolvedValue({ kind: "wait", seconds: 42 })
    const res = await POST(req({ challengeId: "cid" }, "dg_plc=SEC"))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: "Please wait before requesting another code.", seconds: 42 })
  })
  it("restart -> 410 and clears dg_plc; bad body -> 410", async () => {
    h.resend.mockResolvedValue({ kind: "restart" })
    const a = await POST(req({ challengeId: "cid" }, "dg_plc=SEC"))
    expect(a.status).toBe(410)
    expect(a.headers.getSetCookie().join("\n")).toMatch(/dg_plc=;[^\n]*Max-Age=0/)
    const b = await POST(req("garbage"))
    expect(b.status).toBe(410)
    expect(b.headers.get("Cache-Control")).toBe("no-store")
  })
  it("send_failed -> 503; throw -> 503", async () => {
    h.resend.mockResolvedValueOnce({ kind: "send_failed" })
    expect((await POST(req({ challengeId: "cid" }, "dg_plc=SEC"))).status).toBe(503)
    h.resend.mockRejectedValueOnce(new Error("x"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect((await POST(req({ challengeId: "cid" }, "dg_plc=SEC"))).status).toBe(503)
    spy.mockRestore()
  })
  it("429 when limiter denies", async () => {
    h.limit.mockResolvedValueOnce({ allowed: false })
    const res = await POST(req({ challengeId: "cid" }))
    expect(res.status).toBe(429)
    expect(h.resend).not.toHaveBeenCalled()
  })
})
