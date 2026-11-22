// Every admin approvals/grants route: non-admins get the auth response and the database is never touched;
// admins reach the lib with the verified admin id, never one taken from the request.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  admin: true,
  adminId: "admin-1" as string | undefined,
  clientMade: 0,
  list: vi.fn(async (..._a: any[]): Promise<any> => ({ items: [], total: 0 })),
  decide: vi.fn(async (..._a: any[]): Promise<any> => ({ status: 200, body: { ok: true } })),
  history: vi.fn(async (..._a: any[]): Promise<any> => ({ items: [], total: 0 })),
  grants: vi.fn(async (..._a: any[]): Promise<any> => ({ items: [], total: 0 })),
  remove: vi.fn(async (..._a: any[]): Promise<any> => ({ status: 200, body: { ok: true } })),
}))

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: async () =>
    h.admin
      ? { isAdmin: true, userId: h.adminId, errorResponse: null }
      : { isAdmin: false, errorResponse: NextResponse.json({ error: "Forbidden" }, { status: 403 }) },
}))
vi.mock("@/lib/api-v2/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-v2/store")>("@/lib/api-v2/store")
  return { ...actual, getAdminClient: () => { h.clientMade++; return { from() { throw new Error("no db in tests") } } } }
})
vi.mock("@/lib/api-v2/approvals", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-v2/approvals")>("@/lib/api-v2/approvals")
  return {
    ...actual,
    listApprovals: (...a: any[]) => h.list(...a),
    decide: (...a: any[]) => h.decide(...a),
    listHistory: (...a: any[]) => h.history(...a),
    listGrants: (...a: any[]) => h.grants(...a),
    removeGrant: (...a: any[]) => h.remove(...a),
  }
})

import { GET as listGETRoute } from "./route"
import { POST as decidePOSTRoute } from "./[id]/route"
import { GET as historyGETRoute } from "./history/route"
import { GET as grantsGETRoute } from "../grants/route"
import { DELETE as grantDELETERoute } from "../grants/[userId]/route"

const req = (url: string, body?: any) => ({ url, headers: new Headers(), json: async () => body }) as any
const ctx = (p: Record<string, string>): any => ({ params: Promise.resolve(p) })
// The routes return the admin guard's errorResponse (typed as possibly undefined); unwrap for assertions.
const listGET = async (r: any) => (await listGETRoute(r))!
const decidePOST = async (r: any, c: any) => (await decidePOSTRoute(r, c))!
const historyGET = async (r: any) => (await historyGETRoute(r))!
const grantsGET = async (r: any) => (await grantsGETRoute(r))!
const grantDELETE = async (r: any, c: any) => (await grantDELETERoute(r, c))!

beforeEach(() => {
  h.admin = true
  h.adminId = "admin-1"
  h.clientMade = 0
  for (const f of [h.list, h.decide, h.history, h.grants, h.remove]) f.mockClear()
})

describe("auth on every method", () => {
  it("non-admins get the auth response and nothing is read or decided", async () => {
    h.admin = false
    const results = await Promise.all([
      listGET(req("http://x/api/admin/api-v2/approvals")),
      decidePOST(req("http://x", { kind: "key", action: "approve" }), ctx({ id: "k1" })),
      historyGET(req("http://x/api/admin/api-v2/approvals/history")),
      grantsGET(req("http://x/api/admin/api-v2/grants")),
      grantDELETE(req("http://x", { reason: "Misuse" }), ctx({ userId: "u1" })),
    ])
    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403, 403])
    expect(h.clientMade).toBe(0)
    for (const f of [h.list, h.decide, h.history, h.grants, h.remove]) expect(f).not.toHaveBeenCalled()
  })
})

describe("GET approvals", () => {
  it("passes q and page through; an error is 500", async () => {
    await listGET(req("http://x/api/admin/api-v2/approvals?q=api-7k3q9m&page=2"))
    expect(h.list.mock.calls[0][1]).toEqual({ q: "api-7k3q9m", page: 2 })
    h.list.mockResolvedValueOnce("error")
    expect((await listGET(req("http://x/api/admin/api-v2/approvals"))).status).toBe(500)
  })
  it("a non-numeric or negative page reads as 0", async () => {
    await listGET(req("http://x/api/admin/api-v2/approvals?page=-3"))
    await listGET(req("http://x/api/admin/api-v2/approvals?page=abc"))
    expect(h.list.mock.calls.map((c) => c[1].page)).toEqual([0, 0])
  })
})

describe("POST approvals/[id]", () => {
  it("decides with the verified admin id, never one from the body", async () => {
    await decidePOST(req("http://x", { kind: "access", action: "reject", reason: "No", actorId: "attacker" }), ctx({ id: "r1" }))
    expect(h.decide.mock.calls[0][1]).toEqual({ kind: "access", action: "reject", id: "r1", actorId: "admin-1", reason: "No" })
  })
  it("swap requests decide as key requests", async () => {
    await decidePOST(req("http://x", { kind: "swap", action: "approve" }), ctx({ id: "k1" }))
    expect(h.decide.mock.calls[0][1]).toMatchObject({ kind: "key", action: "approve" })
  })
  it("an unknown kind or action is 400", async () => {
    expect((await decidePOST(req("http://x", { kind: "bogus", action: "approve" }), ctx({ id: "k1" }))).status).toBe(400)
    expect((await decidePOST(req("http://x", { kind: "key", action: "delete" }), ctx({ id: "k1" }))).status).toBe(400)
    expect(h.decide).not.toHaveBeenCalled()
  })
  it("returns the lib's status and body", async () => {
    h.decide.mockResolvedValueOnce({ status: 409, body: { error: "stale", code: "stale" } })
    const res = await decidePOST(req("http://x", { kind: "key", action: "approve" }), ctx({ id: "k1" }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "stale", code: "stale" })
  })
})

describe("grants", () => {
  it("DELETE removes with the admin id and the reason", async () => {
    await grantDELETE(req("http://x", { reason: "Misuse" }), ctx({ userId: "u1" }))
    expect(h.remove.mock.calls[0][1]).toEqual({ userId: "u1", actorId: "admin-1", reason: "Misuse" })
  })
  it("GET lists, and an error is 500", async () => {
    expect((await grantsGET(req("http://x/api/admin/api-v2/grants?page=1"))).status).toBe(200)
    expect(h.grants.mock.calls[0][1]).toBe(1)
    h.grants.mockResolvedValueOnce("error")
    expect((await grantsGET(req("http://x/api/admin/api-v2/grants"))).status).toBe(500)
  })
})

describe("history", () => {
  it("lists by page", async () => {
    expect((await historyGET(req("http://x/api/admin/api-v2/approvals/history?page=3"))).status).toBe(200)
    expect(h.history.mock.calls[0][1]).toBe(3)
  })
})
