// Every admin console write route: non-admins get the auth response, the CRON_SECRET path (no user id) gets 403,
// and the actor passed to SQL is always the verified admin, never a body value.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextResponse } from "next/server"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const UID = "11111111-1111-4111-8111-111111111111"
const h = vi.hoisted(() => ({
  admin: true,
  adminId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as string | undefined,
  clientMade: 0,
  rpc: vi.fn(async (..._a: any[]): Promise<any> => ({ data: { ok: true, changed: true, id: "x" }, error: null })),
  invalidate: vi.fn(),
}))

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: async () =>
    h.admin
      ? { isAdmin: true, userId: h.adminId, errorResponse: null }
      : { isAdmin: false, errorResponse: NextResponse.json({ error: "Forbidden" }, { status: 403 }) },
}))
vi.mock("@/lib/api-v2/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-v2/store")>("@/lib/api-v2/store")
  return { ...actual, getAdminClient: () => { h.clientMade++; return { rpc: (...a: any[]) => h.rpc(...a), from() { throw new Error("no db") } } } }
})
vi.mock("@/lib/api-v2/controls", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-v2/controls")>("@/lib/api-v2/controls")
  return { ...actual, getControls: () => ({ invalidate: h.invalidate }) }
})

import { POST as pauseRoute } from "./developers/[userId]/pause/route"
import { PUT as serviceRoute } from "./services/[service]/route"
import { POST as annCreateRoute } from "./announcements/route"
import { PUT as annPutRoute, DELETE as annDeleteRoute } from "./announcements/[id]/route"

const req = (body?: any) => ({ url: "http://x", headers: new Headers(), json: async () => body }) as any
const ctx = (p: Record<string, string>): any => ({ params: Promise.resolve(p) })
const annBody = { title: "Maintenance", body: "Brief downtime.", severity: "info", startsAt: "2026-12-01T10:00:00Z", endsAt: "2026-12-01T12:00:00Z" }

const calls: [string, () => Promise<Response | null | undefined>][] = [
  ["pause", () => pauseRoute(req({ paused: true, reason: "Abuse seen" }), ctx({ userId: UID }))],
  ["service", () => serviceRoute(req({ paused: true, message: "Back soon" }), ctx({ service: "data" }))],
  ["announce create", () => annCreateRoute(req(annBody))],
  ["announce put", () => annPutRoute(req(annBody), ctx({ id: UID }))],
  ["announce delete", () => annDeleteRoute(req(), ctx({ id: UID }))],
]

beforeEach(() => {
  h.admin = true
  h.adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  h.clientMade = 0
  h.rpc.mockClear()
  h.invalidate.mockClear()
})

describe.each(calls)("%s", (_name, run) => {
  it("no admin -> the auth response, no client, no rpc", async () => {
    h.admin = false
    const r = (await run())!
    expect(r.status).toBe(403)
    expect(h.clientMade).toBe(0)
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it("CRON_SECRET path (admin without a user id) -> 403 with the sign-in message and no rpc", async () => {
    h.adminId = undefined
    const r = (await run())!
    expect(r.status).toBe(403)
    expect((await r.json()).error).toBe("Sign in with an admin account to do this.")
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it("admin -> 200 and the rpc actor is the verified admin", async () => {
    const r = (await run())!
    expect(r.status).toBe(200)
    expect(h.rpc.mock.calls[0][1].p_actor).toBe(h.adminId)
  })
})

describe("body-supplied identity is ignored", () => {
  it("actorId / userId / p_actor in the body never reach the rpc", async () => {
    const evil = { actorId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", userId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", p_actor: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }
    await pauseRoute(req({ paused: true, reason: "Abuse seen", ...evil }), ctx({ userId: UID }))
    await serviceRoute(req({ paused: true, message: "x", ...evil }), ctx({ service: "sms" }))
    await annCreateRoute(req({ ...annBody, ...evil }))
    await annPutRoute(req({ ...annBody, ...evil, id: evil.userId }), ctx({ id: UID }))
    await annDeleteRoute(req(evil), ctx({ id: UID }))
    expect(h.rpc).toHaveBeenCalledTimes(5)
    for (const c of h.rpc.mock.calls) expect(c[1].p_actor).toBe(h.adminId)
    expect(h.rpc.mock.calls[0][1].p_user).toBe(UID)
    expect(h.rpc.mock.calls[3][1].p_id).toBe(UID)
  })
})

describe("route behaviour", () => {
  it("invalid input is 400 before any rpc", async () => {
    expect((await pauseRoute(req({ paused: true, reason: "Abuse" }), ctx({ userId: "not-a-uuid" })))!.status).toBe(400)
    expect((await serviceRoute(req({ paused: true }), ctx({ service: "nope" })))!.status).toBe(404)
    expect((await serviceRoute(req({ paused: "yes" }), ctx({ service: "data" })))!.status).toBe(400)
    expect((await annCreateRoute(req({ ...annBody, severity: "x" })))!.status).toBe(400)
    expect((await annCreateRoute({ url: "http://x", headers: new Headers(), json: async () => { throw new Error("bad json") } } as any))!.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it("a changed developer pause and a changed service pause both clear the controls snapshot", async () => {
    await pauseRoute(req({ paused: true, reason: "Abuse seen" }), ctx({ userId: UID }))
    await serviceRoute(req({ paused: true, message: null }), ctx({ service: "bills" }))
    expect(h.invalidate).toHaveBeenCalledTimes(2)
  })
  it("a failed rpc is a generic 500 with no success flag", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "leak 0244123456" } })
    const r = (await pauseRoute(req({ paused: true, reason: "Abuse seen" }), ctx({ userId: UID })))!
    const body = await r.json()
    expect(r.status).toBe(500)
    expect(body.ok).toBeUndefined()
    expect(JSON.stringify(body)).not.toMatch(/leak|0244/)
    expect(h.invalidate).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe("route files export only handlers", () => {
  const files: [string, string[]][] = [
    ["developers/[userId]/pause/route.ts", ["POST"]],
    ["services/[service]/route.ts", ["PUT"]],
    ["announcements/route.ts", ["POST"]],
    ["announcements/[id]/route.ts", ["PUT", "DELETE"]],
  ]
  it.each(files)("%s", async (file, expected) => {
    const src = readFileSync(join(__dirname, file), "utf8")
    const exported = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/gm)].map((m) => m[1])
    expect(exported.sort()).toEqual([...expected].sort())
    expect(/^export\s+(?!async function)/m.test(src)).toBe(false)
  })
})

describe("review fixes (routes)", () => {
  it("unknown service route -> 404 not_found", async () => {
    const r = (await serviceRoute(req({ paused: true }), ctx({ service: "nope" })))!
    expect(r.status).toBe(404)
    expect((await r.json()).code).toBe("not_found")
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it("pause on a missing developer -> 404", async () => {
    h.rpc.mockResolvedValueOnce({ data: { ok: false, code: "not_found" }, error: null })
    expect((await pauseRoute(req({ paused: true, reason: "Abuse seen" }), ctx({ userId: UID })))!.status).toBe(404)
    expect(h.invalidate).not.toHaveBeenCalled()
  })
  it("announcement too_many -> 409", async () => {
    h.rpc.mockResolvedValueOnce({ data: { ok: false, code: "too_many" }, error: null })
    expect((await annCreateRoute(req(annBody)))!.status).toBe(409)
  })
  it("non-boolean paused on both pause routes -> 400, no rpc", async () => {
    expect((await pauseRoute(req({ paused: "true", reason: "Abuse seen" }), ctx({ userId: UID })))!.status).toBe(400)
    expect((await serviceRoute(req({ paused: 1 }), ctx({ service: "data" })))!.status).toBe(400)
    expect((await pauseRoute(req({ paused: ["x"], reason: { a: 1 } }), ctx({ userId: UID })))!.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })
});
