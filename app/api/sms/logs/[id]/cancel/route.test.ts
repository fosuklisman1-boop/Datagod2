import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  auth: { account: { id: "acct1" }, user: { id: "u1" } } as any,
  cancel: vi.fn(),
}))
vi.mock("@/lib/sms/tenant-auth", () => ({ resolveAccount: () => Promise.resolve(h.auth) }))
vi.mock("@/lib/sms/scheduled-service", () => ({ cancelScheduledCampaign: h.cancel }))

import { POST } from "./route"

function call(id: string) {
  const req = new NextRequest(`http://localhost/api/sms/logs/${id}/cancel`, { method: "POST" })
  return POST(req, { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  h.auth = { account: { id: "acct1" }, user: { id: "u1" } }
  h.cancel.mockReset()
})

describe("POST /api/sms/logs/[id]/cancel", () => {
  it("requires a resolved account", async () => {
    h.auth = { error: NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 }) }
    expect((await call("42")).status).toBe(401)
    expect(h.cancel).not.toHaveBeenCalled()
  })

  it("cancels the caller's own log and reports the refund", async () => {
    h.cancel.mockResolvedValue({ ok: true, already: false, refunded: 12 })
    const res = await call("42")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { cancelled: true, refunded: 12 } })
    expect(h.cancel).toHaveBeenCalledWith("acct1", "42", "cancelled by customer")
  })

  it("a repeat cancel is ok with already: true", async () => {
    h.cancel.mockResolvedValue({ ok: true, already: true, refunded: 0 })
    expect(await (await call("42")).json()).toEqual({ success: true, data: { cancelled: true, already: true, refunded: 0 } })
  })

  it("another account's log → 404 (indistinguishable from a missing one)", async () => {
    h.cancel.mockResolvedValue({ ok: false, code: "NOT_FOUND", error: "Campaign not found" })
    const res = await call("42")
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: "Campaign not found", code: "NOT_FOUND" })
  })

  it("maps the other service errors", async () => {
    const cases: [string, number][] = [["INVALID", 400], ["NOT_SCHEDULED", 409], ["DB", 500]]
    for (const [code, status] of cases) {
      h.cancel.mockResolvedValueOnce({ ok: false, code, error: `e-${code}` })
      const res = await call("42")
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ success: false, error: `e-${code}`, code })
    }
  })

  it("a throw → 500", async () => {
    h.cancel.mockRejectedValue(new Error("boom"))
    expect((await call("42")).status).toBe(500)
  })
})
