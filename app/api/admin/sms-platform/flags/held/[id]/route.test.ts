import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  guard: { ok: true, adminId: "admin1" } as any,
  guardOpts: [] as any[],
  release: vi.fn(),
  reject: vi.fn(),
}))
vi.mock("@/lib/sms/admin-guard", () => ({
  adminGuard: (_req: any, opts: any) => { h.guardOpts.push(opts); return Promise.resolve(h.guard) },
}))
vi.mock("@/lib/sms/held-service", () => ({
  releaseHeldCampaign: h.release,
  rejectHeldCampaign: h.reject,
  parseLogId: (raw: string) => (/^[1-9]\d*$/.test(raw) ? Number(raw) : null),
}))

import { POST } from "./route"

function call(id: string, body: unknown, raw = false) {
  const req = new NextRequest(`http://localhost/api/admin/sms-platform/flags/held/${id}`, {
    method: "POST",
    body: raw ? (body as string) : JSON.stringify(body),
  })
  return POST(req, { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  h.guard = { ok: true, adminId: "admin1" }
  h.guardOpts = []
  h.release.mockReset()
  h.reject.mockReset()
})

describe("POST /api/admin/sms-platform/flags/held/[id]", () => {
  it("requires a write-capable admin", async () => {
    h.guard = { ok: false, response: NextResponse.json({ success: false, error: "Admin access required" }, { status: 403 }) }
    const res = await call("42", { action: "release" })
    expect(res.status).toBe(403)
    expect(h.guardOpts[0]).toEqual({ write: true })
    expect(h.release).not.toHaveBeenCalled()
  })

  it("rejects a non-integer id", async () => {
    for (const id of ["abc", "0", "held:4", "1.5"]) {
      const res = await call(id, { action: "release" })
      expect(res.status).toBe(400)
    }
    expect(h.release).not.toHaveBeenCalled()
  })

  it("rejects bad JSON and unknown actions", async () => {
    expect((await call("42", "{nope", true)).status).toBe(400)
    expect((await call("42", { action: "delete" })).status).toBe(400)
    expect((await call("42", [1])).status).toBe(400)
  })

  it("release → service result", async () => {
    h.release.mockResolvedValue({ ok: true, already: false, placed: 3 })
    const res = await call("42", { action: "release" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { already: false, placed: 3 } })
    expect(h.release).toHaveBeenCalledWith("admin1", 42)
  })

  it("reject passes the reason through", async () => {
    h.reject.mockResolvedValue({ ok: true, already: false, refundedCredits: 10, refundedMessages: 5 })
    const res = await call("42", { action: "reject", reason: "phishing link" })
    expect(await res.json()).toEqual({ success: true, data: { already: false, refundedCredits: 10, refundedMessages: 5 } })
    expect(h.reject).toHaveBeenCalledWith("admin1", 42, "phishing link")
  })

  it("maps service error codes to HTTP statuses", async () => {
    const cases: [string, number][] = [["INVALID", 400], ["NOT_FOUND", 404], ["NOT_HELD", 409], ["REJECTED", 409], ["SMS_DISABLED", 409], ["DB", 500]]
    for (const [code, status] of cases) {
      h.release.mockResolvedValueOnce({ ok: false, code, error: `e-${code}` })
      const res = await call("42", { action: "release" })
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ success: false, error: `e-${code}`, code })
    }
  })
})
