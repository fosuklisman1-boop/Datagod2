import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

type Op = { method: string; args: unknown[] }
type Call = { table: string; ops: Op[] }
let calls: Call[] = []
let handler: (c: Call) => { data?: unknown; error?: unknown }

function chain(table: string) {
  const call: Call = { table, ops: [] }
  calls.push(call)
  const proxy: Record<string, unknown> = {}
  for (const m of ["select", "eq", "order", "limit", "update"]) {
    proxy[m] = (...args: unknown[]) => {
      call.ops.push({ method: m, args })
      return proxy
    }
  }
  proxy.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(handler(call)).then(res, rej)
  return proxy
}
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (t: string) => chain(t) } }))
const authMock = vi.fn()
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: (...a: unknown[]) => authMock(...a) }))

import { GET, PATCH } from "./route"

const URL_ = "http://localhost/api/admin/momo-claims/sessions"
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SID = "11111111-2222-4333-8444-555555555555"
const NOW = new Date("2026-11-11T12:00:00.000Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString()

const req = (method: string, body?: unknown) =>
  new NextRequest(URL_, {
    method,
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

let rows: unknown[] = []
let updateRows: unknown[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  calls = []
  vi.clearAllMocks()
  rows = []
  updateRows = []
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-placeholder"
  authMock.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  handler = (c) => (c.ops.some((o) => o.method === "update") ? { data: updateRows, error: null } : { data: rows, error: null })
})
afterEach(() => vi.useRealTimers())

describe("auth", () => {
  it("returns errorResponse as-is", async () => {
    authMock.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Admin access required" }, { status: 403 }) })
    expect((await GET(req("GET"))).status).toBe(403)
    expect((await PATCH(req("PATCH", {}))).status).toBe(403)
    expect(calls).toHaveLength(0)
  })
  it("503 without the service key", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    expect((await GET(req("GET"))).status).toBe(503)
    expect((await PATCH(req("PATCH", {}))).status).toBe(503)
  })
  it("GET works for cron bypass, PATCH needs a userId", async () => {
    authMock.mockResolvedValue({ isAdmin: true })
    expect((await GET(req("GET"))).status).toBe(200)
    const res = await PATCH(req("PATCH", { id: SID, action: "force_expire" }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("admin_user_required")
    expect(calls.some((c) => c.ops.some((o) => o.method === "update"))).toBe(false)
  })
})

describe("GET", () => {
  it("returns latest 200 mapped, showing pending-but-expired as expired", async () => {
    rows = [
      { id: "a", user_id: "u1", code: "ABC2345", amount: 10, fee: 0.1, net_amount: 9.9, status: "pending", created_at: ago(1000), expires_at: ahead(1000), claimed_transaction_id: null },
      { id: "b", user_id: "u2", code: "DEF2345", amount: 5, fee: 0, net_amount: 5, status: "pending", created_at: ago(9000), expires_at: ago(1000), claimed_transaction_id: null },
      { id: "c", user_id: "u3", code: "GHJ2345", amount: 5, fee: 0, net_amount: 5, status: "claimed", created_at: ago(9000), expires_at: ago(1000), claimed_transaction_id: "123" },
    ]
    const res = await GET(req("GET"))
    const j = await res.json()
    expect(j.sessions.map((s: { status: string }) => s.status)).toEqual(["pending", "expired", "claimed"])
    expect(j.sessions[0]).toEqual({
      id: "a", userId: "u1", code: "ABC2345", amount: 10, fee: 0.1, netAmount: 9.9, status: "pending",
      createdAt: ago(1000), expiresAt: ahead(1000), claimedTransactionId: null,
    })
    const q = calls[0]
    expect(q.table).toBe("wallet_topup_sessions")
    expect(q.ops).toContainEqual({ method: "limit", args: [200] })
    expect(q.ops).toContainEqual({ method: "order", args: ["created_at", { ascending: false }] })
  })
})

describe("PATCH force_expire", () => {
  it("one conditional update; 200 when a row changed", async () => {
    updateRows = [{ id: SID }]
    const res = await PATCH(req("PATCH", { id: SID, action: "force_expire" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const updates = calls.filter((c) => c.ops.some((o) => o.method === "update"))
    expect(updates).toHaveLength(1)
    const u = updates[0]
    expect(u.ops.find((o) => o.method === "update")!.args[0]).toEqual({ status: "expired", force_expired_by: ADMIN })
    expect(u.ops).toContainEqual({ method: "eq", args: ["id", SID] })
    expect(u.ops).toContainEqual({ method: "eq", args: ["status", "pending"] })
  })

  it("409 when no pending row matched", async () => {
    updateRows = []
    expect((await PATCH(req("PATCH", { id: SID, action: "force_expire" }))).status).toBe(409)
  })

  it("400 for non-uuid id, unknown action or bad body, without updating", async () => {
    expect((await PATCH(req("PATCH", { id: "nope", action: "force_expire" }))).status).toBe(400)
    expect((await PATCH(req("PATCH", { id: SID, action: "other" }))).status).toBe(400)
    const bad = new NextRequest(URL_, { method: "PATCH", headers: { authorization: "Bearer tok" }, body: "{nope" })
    expect((await PATCH(bad)).status).toBe(400)
    expect(calls.some((c) => c.ops.some((o) => o.method === "update"))).toBe(false)
  })
})
