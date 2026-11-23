import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  world: {} as any,
  sessionUser: { id: "u1" } as { id: string } | null,
  create: vi.fn(async (..._a: any[]): Promise<any> => ({ ok: true, id: "req-1", code: "API-M4T8WX", alert: true })),
  cancel: vi.fn(async (..._a: any[]): Promise<any> => "cancelled"),
  alertAdmins: vi.fn(async (..._a: any[]): Promise<unknown> => []),
  notifyUser: vi.fn(async (..._a: any[]): Promise<unknown> => []),
  limited: false,
}))

vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: !h.limited }) }))
vi.mock("@/lib/roles/require-capability", () => ({
  requireCapability: async () => {
    const c = h.world.cap
    if (c === "yes") return null
    if (c === "error") return NextResponse.json({ error: "x" }, { status: 503 })
    return NextResponse.json({ error: "no" }, { status: 403 })
  },
}))
vi.mock("@/lib/admin-actions", () => ({
  alertAdminsOfRequest: (...a: any[]) => h.alertAdmins(...a),
  notifyUserOfOutcome: (...a: any[]) => h.notifyUser(...a),
}))
vi.mock("@/lib/api-v2/access-requests", () => ({
  createAccessRequest: (...a: any[]) => h.create(...a),
  cancelAccessRequest: (...a: any[]) => h.cancel(...a),
}))
vi.mock("@/lib/api-v2/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-v2/store")>("@/lib/api-v2/store")
  return {
    ...actual,
    getAdminClient: () => ({
      auth: { getUser: async () => ({ data: { user: h.sessionUser } }) },
      from(table: string) {
        const w = h.world
        const result = () => {
          if (table === "users") {
            if (w.userError) return { data: null, error: { message: "x" } }
            return { data: { role: w.role, is_suspended: w.suspended ?? false, email: "kofi@example.com", first_name: "Kofi", last_name: null }, error: null }
          }
          if (table === "api_v2_config") return { data: { enabled: w.enabled ?? true, allowed_roles: w.allowed ?? ["dealer"] }, error: null }
          if (table === "api_v2_access_grants") {
            return w.grant === "error" ? { data: null, error: { message: "x" } } : { data: w.grant ? { user_id: "u1" } : null, error: null }
          }
          return { data: null, error: null }
        }
        const b: any = {
          select() { return b },
          eq() { return b },
          maybeSingle() { return Promise.resolve(result()) },
          then(res: any, rej: any) { return Promise.resolve(result()).then(res, rej) },
        }
        return b
      },
    }),
  }
})

import { DELETE, POST } from "./route"

const world = (over: any = {}) => {
  h.world = { role: "user", cap: "yes", grant: false, enabled: true, allowed: ["dealer"], suspended: false, ...over }
}
const req = (body: any = {}) => ({ headers: new Headers({ Authorization: "Bearer t" }), json: async () => body }) as any

beforeEach(() => {
  h.sessionUser = { id: "u1" }
  h.limited = false
  h.create.mockReset()
  h.create.mockResolvedValue({ ok: true, id: "req-1", code: "API-M4T8WX", alert: true })
  h.cancel.mockReset()
  h.cancel.mockResolvedValue("cancelled")
  h.alertAdmins.mockReset()
  h.alertAdmins.mockResolvedValue([])
  h.notifyUser.mockReset()
  h.notifyUser.mockResolvedValue([])
  world()
})

describe("POST /api/user/v2-api-access", () => {
  it("opens a request for the session user, returns the code and alerts admins and the owner", async () => {
    const res = await POST(req())
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: "req-1", code: "API-M4T8WX", status: "pending" })
    expect(h.create.mock.calls[0][1]).toBe("u1")
    expect(h.alertAdmins).toHaveBeenCalledWith("api_access", expect.objectContaining({ kind: "access", code: "API-M4T8WX" }))
    expect(h.notifyUser).toHaveBeenCalledWith("api_access", "requested", expect.objectContaining({ userId: "u1" }), expect.objectContaining({ kind: "access" }))
  })
  it("no session is 401 and nothing is created", async () => {
    h.sessionUser = null
    expect((await POST(req())).status).toBe(401)
    expect(h.create).not.toHaveBeenCalled()
  })
  it("ignores a user_id in the body", async () => {
    await POST(req({ user_id: "someone-else" }))
    expect(h.create.mock.calls[0][1]).toBe("u1")
  })
  it("disabled is 503, suspended is 403, rate limited is 429", async () => {
    world({ enabled: false })
    expect((await POST(req())).status).toBe(503)
    world({ suspended: true })
    expect((await POST(req())).status).toBe(403)
    world()
    h.limited = true
    expect((await POST(req())).status).toBe(429)
    expect(h.create).not.toHaveBeenCalled()
  })
  it("someone who can already create keys gets 409 (allowed role with capability, or a grant)", async () => {
    world({ role: "dealer" })
    expect((await POST(req())).status).toBe(409)
    world({ role: "user", grant: true })
    expect((await POST(req())).status).toBe(409)
    expect(h.create).not.toHaveBeenCalled()
  })
  it("an allowed role WITHOUT the capability may still ask", async () => {
    world({ role: "dealer", cap: "no" })
    expect((await POST(req())).status).toBe(201)
  })
  it("a users, capability or grant read error is 503, never a request", async () => {
    for (const over of [{ userError: true }, { cap: "error" }, { grant: "error" }]) {
      world(over)
      expect((await POST(req())).status).toBe(503)
    }
    expect(h.create).not.toHaveBeenCalled()
  })
  it("an open request is 409; within 24 h of a rejection is 429 with the retry time", async () => {
    h.create.mockResolvedValueOnce({ ok: false, status: 409 })
    expect((await POST(req())).status).toBe(409)
    h.create.mockResolvedValueOnce({ ok: false, status: 429, retryAt: "2026-11-23T10:00:00.000Z" })
    const res = await POST(req())
    expect(res.status).toBe(429)
    expect((await res.json()).retryAt).toBe("2026-11-23T10:00:00.000Z")
  })
  it("a repeat request inside 24 h is created without alerts", async () => {
    h.create.mockResolvedValueOnce({ ok: true, id: "req-2", code: "API-ZZZZZZ", alert: false })
    expect((await POST(req())).status).toBe(201)
    expect(h.alertAdmins).not.toHaveBeenCalled()
    expect(h.notifyUser).not.toHaveBeenCalled()
  })
  it("answers without waiting for the notifications", async () => {
    h.alertAdmins.mockReturnValueOnce(new Promise(() => {}))
    expect((await POST(req())).status).toBe(201)
  })
  it("a notifier failure still answers 201", async () => {
    h.alertAdmins.mockRejectedValueOnce(new Error("down"))
    expect((await POST(req())).status).toBe(201)
    expect(h.create).toHaveBeenCalledTimes(1)
  })
})

describe("DELETE /api/user/v2-api-access", () => {
  it("cancels only the session user's pending request", async () => {
    expect((await DELETE(req())).status).toBe(200)
    expect(h.cancel.mock.calls[0][1]).toBe("u1")
  })
  it("401 without a session, 404 when nothing is open, 500 on error", async () => {
    h.sessionUser = null
    expect((await DELETE(req())).status).toBe(401)
    h.sessionUser = { id: "u1" }
    h.cancel.mockResolvedValueOnce("none")
    expect((await DELETE(req())).status).toBe(404)
    h.cancel.mockResolvedValueOnce("error")
    expect((await DELETE(req())).status).toBe(500)
  })
})
