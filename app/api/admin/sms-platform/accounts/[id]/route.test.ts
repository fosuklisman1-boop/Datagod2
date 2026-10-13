import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  guard: { ok: true, adminId: "admin1" } as any,
  guardOpts: [] as any[],
  setMode: vi.fn(),
  setLimit: vi.fn(),
  setHold: vi.fn(),
}))
vi.mock("@/lib/sms/admin-guard", () => ({
  adminGuard: (_r: any, opts: any) => { h.guardOpts.push(opts); return Promise.resolve(h.guard) },
}))
vi.mock("@/lib/sms/sender-rules-service", () => ({ setAccountMode: h.setMode, setApiRateLimitOverride: h.setLimit }))
vi.mock("@/lib/sms/review-hold-service", () => ({ setReviewHold: h.setHold }))

import { PATCH } from "./route"

const ACCT = "11111111-1111-4111-8111-111111111111"
function call(body: unknown, raw = false) {
  const req = new NextRequest(`http://localhost/api/admin/sms-platform/accounts/${ACCT}`, { method: "PATCH", body: raw ? (body as string) : JSON.stringify(body) })
  return PATCH(req, { params: Promise.resolve({ id: ACCT }) })
}

beforeEach(() => {
  h.guard = { ok: true, adminId: "admin1" }; h.guardOpts = []
  h.setMode.mockReset(); h.setLimit.mockReset(); h.setHold.mockReset()
})

describe("PATCH /api/admin/sms-platform/accounts/[id] — review_hold", () => {
  it("requires a write admin", async () => {
    h.guard = { ok: false, response: NextResponse.json({ success: false }, { status: 403 }) }
    expect((await call({ review_hold: false })).status).toBe(403)
    expect(h.guardOpts[0]).toEqual({ write: true })
    expect(h.setHold).not.toHaveBeenCalled()
  })

  it("clears the hold through the service", async () => {
    h.setHold.mockResolvedValue({ ok: true, changed: true, review_hold: false, flagsClosed: 3 })
    const res = await call({ review_hold: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { review_hold: false, review_hold_changed: true, flags_closed: 3 } })
    expect(h.setHold).toHaveBeenCalledWith("admin1", ACCT, false)
  })

  it("rejects a non-boolean review_hold", async () => {
    for (const v of ["false", 0, null]) expect((await call({ review_hold: v })).status).toBe(400)
    expect(h.setHold).not.toHaveBeenCalled()
  })

  it("404s an unknown account and 400s other service errors", async () => {
    h.setHold.mockResolvedValueOnce({ ok: false, error: "Account not found", notFound: true })
    expect((await call({ review_hold: true })).status).toBe(404)
    h.setHold.mockResolvedValueOnce({ ok: false, error: "Could not update the review hold" })
    expect((await call({ review_hold: true })).status).toBe(400)
  })

  it("keeps the existing behaviour: nothing to update / bad JSON / mode only", async () => {
    expect((await call({})).status).toBe(400)
    expect((await call("{x", true)).status).toBe(400)
    h.setMode.mockResolvedValue({ ok: true, data: "business" })
    const res = await call({ mode: "business" })
    expect(await res.json()).toEqual({ success: true, data: { mode: "business" } })
    expect(h.setHold).not.toHaveBeenCalled()
  })
})
