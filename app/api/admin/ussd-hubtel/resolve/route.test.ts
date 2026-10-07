// app/api/admin/ussd-hubtel/resolve/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ auth: { isAdmin: true, userId: "admin-1" } as any, resolve: vi.fn() }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))
vi.mock("@/lib/ussd-hubtel/resolve", () => ({ resolveNeedsReview: (...a: any[]) => h.resolve(...a) }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/ussd-hubtel/order-handlers", () => ({
  createStrictFailHandlers: () => ({ kind: "strict" }),
  createFailHandlers: () => ({ kind: "lenient" }),
}))

import { POST } from "./route"

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/ussd-hubtel/resolve", { method: "POST", body: JSON.stringify(body) })
const good = { sessionId: "S1", outcome: "fulfilled", note: "Delivered manually" }

beforeEach(() => {
  h.auth = { isAdmin: true, userId: "admin-1" }
  h.resolve.mockReset()
})

describe("POST /api/admin/ussd-hubtel/resolve", () => {
  it("refuses a caller with no admin user id (CRON bypass): the audit log needs one", async () => {
    h.auth = { isAdmin: true }
    const res = await POST(post(good))
    expect(res.status).toBe(403)
    expect(h.resolve).not.toHaveBeenCalled()
  })
  it("400 on a malformed body", async () => {
    for (const body of [{}, { ...good, outcome: "refunded" }, { ...good, note: 5 }, { ...good, sessionId: "" }]) {
      expect((await POST(post(body))).status).toBe(400)
    }
    expect(h.resolve).not.toHaveBeenCalled()
  })
  it("passes the admin id through and maps a refusal to its status", async () => {
    h.resolve.mockResolvedValue({ ok: false, status: 409, error: "changed" })
    const res = await POST(post(good))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "changed" })
    expect(h.resolve.mock.calls[0][0]).toMatchObject({ sessionId: "S1", outcome: "fulfilled", note: "Delivered manually", adminId: "admin-1" })
  })
  it("200 with the result on success", async () => {
    h.resolve.mockResolvedValue({ ok: true, state: "fulfilled", callbackStatus: "pending", callbackNote: "Success callback queued." })
    const res = await POST(post(good))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, callbackNote: "Success callback queued." })
  })
  it("(M2) a rate-limited admin (isAdmin true + 429 errorResponse) gets the 429, resolve not called", async () => {
    h.auth = { isAdmin: true, userId: "admin-1", errorResponse: new Response(JSON.stringify({ error: "slow down" }), { status: 429 }) }
    const res = await POST(post(good))
    expect(res.status).toBe(429)
    expect(h.resolve).not.toHaveBeenCalled()
  })
  it("(M2) a JSON null / array / scalar body is a 400, not a 500", async () => {
    for (const body of [null, [], 5, "x"]) {
      expect((await POST(post(body))).status).toBe(400)
    }
    const raw = new NextRequest("http://localhost/api/admin/ussd-hubtel/resolve", { method: "POST", body: "not json" })
    expect((await POST(raw)).status).toBe(400)
    expect(h.resolve).not.toHaveBeenCalled()
  })
  it("(M2) passes a resolve warning through to the client", async () => {
    h.resolve.mockResolvedValue({ ok: true, state: "failed", callbackStatus: "not_due", callbackNote: "No callback", warning: "may still be payable" })
    const res = await POST(post({ ...good, outcome: "not_paid" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ warning: "may still be payable" })
  })
  it("(M2) not_paid uses fail handlers that surface update errors (strict)", async () => {
    h.resolve.mockResolvedValue({ ok: true, state: "failed", callbackStatus: "not_due", callbackNote: "x" })
    await POST(post({ ...good, outcome: "not_paid" }))
    expect(h.resolve.mock.calls[0][0].failHandlers).toEqual({ kind: "strict" })
  })
  it("500 when resolve throws", async () => {
    h.resolve.mockRejectedValue(new Error("db down"))
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await POST(post(good))
    err.mockRestore()
    expect(res.status).toBe(500)
  })
})
