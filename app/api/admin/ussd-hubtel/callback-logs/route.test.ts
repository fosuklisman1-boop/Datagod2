// app/api/admin/ussd-hubtel/callback-logs/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  auth: { isAdmin: true, userId: "admin-1" } as any,
  calls: [] as Array<[string, ...unknown[]]>,
  result: { data: [], error: null } as { data: unknown; error: unknown },
}))

vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      h.calls.push(["from", table])
      const b: any = {}
      for (const m of ["select", "eq", "lt", "order", "limit"]) b[m] = (...a: unknown[]) => { h.calls.push([m, ...a]); return b }
      b.maybeSingle = () => { h.calls.push(["maybeSingle"]); return Promise.resolve(h.result) }
      b.then = (res: any, rej: any) => Promise.resolve(h.result).then(res, rej)
      return b
    },
  }),
}))

import { GET as LIST } from "./route"
import { GET as DETAIL } from "./[id]/route"

const list = (qs = "") => LIST(new NextRequest(`http://localhost/api/admin/ussd-hubtel/callback-logs${qs}`))
const detail = (id: string) =>
  DETAIL(new NextRequest(`http://localhost/api/admin/ussd-hubtel/callback-logs/${id}`), { params: Promise.resolve({ id }) })
const call = (name: string) => h.calls.filter(c => c[0] === name)

const row = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`, created_at: `2026-10-07T10:0${i}:00.000Z`, direction: "inbound_fulfillment",
  session_id: `S${i}`, hubtel_order_id: `H${i}`, outcome: "fulfilled", ok: true, http_status: null, ...extra,
})

beforeEach(() => {
  h.auth = { isAdmin: true, userId: "admin-1" }
  h.calls = []
  h.result = { data: [], error: null }
})

describe("GET /api/admin/ussd-hubtel/callback-logs (list)", () => {
  it("403 for non-admins and 429 passthrough; no query", async () => {
    const { NextResponse } = await import("next/server")
    h.auth = { isAdmin: false }
    expect((await list()).status).toBe(403)
    h.auth = { isAdmin: true, userId: "a", errorResponse: NextResponse.json({ error: "slow" }, { status: 429 }) }
    expect((await list()).status).toBe(429)
    expect((await detail("00000000-0000-4000-8000-000000000001")).status).toBe(429)
    expect(h.calls).toEqual([])
  })
  it("defaults: summary columns only (no payload/raw_body/response), newest first, limit 50 (+1 probe)", async () => {
    h.result = { data: [row(1)], error: null }
    const res = await list()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ logs: [row(1)] })
    const cols = String(call("select")[0][1])
    expect(cols).toBe("id, created_at, direction, session_id, hubtel_order_id, outcome, ok, http_status")
    for (const c of ["payload", "raw_body", "response", "error", "source_ip"]) expect(cols).not.toContain(c)
    expect(call("from")[0][1]).toBe("hubtel_callback_logs")
    expect(call("order")[0]).toEqual(["order", "created_at", { ascending: false }])
    expect(call("limit")[0]).toEqual(["limit", 51])
  })
  it("filters: direction, problemsOnly, before", async () => {
    await list("?direction=outbound_callback&problemsOnly=1&before=2026-10-07T10:00:00.000Z&limit=10")
    expect(call("eq")).toEqual([["eq", "direction", "outbound_callback"], ["eq", "ok", false]])
    expect(call("lt")).toEqual([["lt", "created_at", "2026-10-07T10:00:00.000Z"]])
    expect(call("limit")[0]).toEqual(["limit", 11])
  })
  it("nextBefore is the last row's created_at when there are more rows", async () => {
    h.result = { data: [row(3), row(2), row(1)], error: null }
    const json = await (await list("?limit=2")).json()
    expect(json.logs).toEqual([row(3), row(2)])
    expect(json.nextBefore).toBe(row(2).created_at)
  })
  it("400s on bad params; nothing queried", async () => {
    for (const qs of ["?limit=0", "?limit=101", "?limit=abc", "?limit=2.5", "?direction=sideways", "?before=yesterday", "?problemsOnly=maybe"]) {
      const res = await list(qs)
      expect(res.status, qs).toBe(400)
    }
    expect(h.calls).toEqual([])
  })
  it("table missing (42P01 / PGRST205): 200 { logs: [], tableMissing: true }", async () => {
    for (const code of ["42P01", "PGRST205"]) {
      h.result = { data: null, error: { code, message: "missing" } }
      const res = await list()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ logs: [], tableMissing: true })
    }
  })
  it("other DB errors: 500 without details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    h.result = { data: null, error: { code: "XX000", message: "Failing row contains (secret stuff)" } }
    const res = await list()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret stuff")
  })
})

describe("GET /api/admin/ussd-hubtel/callback-logs/[id] (detail)", () => {
  it("403 for non-admins", async () => {
    h.auth = { isAdmin: false }
    expect((await detail("00000000-0000-4000-8000-000000000001")).status).toBe(403)
  })
  it("400 on a non-uuid id, nothing queried", async () => {
    for (const id of ["abc", "1", "00000000-0000-4000-8000-00000000000Z", "' or 1=1"]) {
      expect((await detail(id)).status, id).toBe(400)
    }
    expect(h.calls).toEqual([])
  })
  it("404 when absent", async () => {
    h.result = { data: null, error: null }
    expect((await detail("00000000-0000-4000-8000-000000000001")).status).toBe(404)
  })
  it("returns the full row", async () => {
    const full = { ...row(1), payload: { SessionId: "S1" }, raw_body: null, response: null, error: null, source_ip: "1.1.1.1" }
    h.result = { data: full, error: null }
    const res = await detail("00000000-0000-4000-8000-000000000001")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ log: full })
    expect(call("select")[0][1]).toBe("*")
    expect(call("eq")[0]).toEqual(["eq", "id", "00000000-0000-4000-8000-000000000001"])
  })
  it("table missing: 404 with tableMissing", async () => {
    h.result = { data: null, error: { code: "42P01", message: "missing" } }
    const res = await detail("00000000-0000-4000-8000-000000000001")
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ tableMissing: true })
  })
})
