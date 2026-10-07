// app/api/admin/ussd-hubtel/callback-logs/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  auth: { isAdmin: true, userId: "admin-1" } as any,
  calls: [] as Array<[string, ...unknown[]]>,
  result: { data: [], error: null } as { data: unknown; error: unknown },
  dataset: null as null | Array<{ id: string; created_at: string }>,
}))

vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      h.calls.push(["from", table])
      const b: any = {}
      const state = { or: null as string | null, limit: Infinity }
      for (const m of ["select", "eq", "lt", "order", "limit", "or"]) b[m] = (...a: unknown[]) => {
        h.calls.push([m, ...a])
        if (m === "or") state.or = String(a[0])
        if (m === "limit") state.limit = Number(a[0])
        return b
      }
      b.maybeSingle = () => { h.calls.push(["maybeSingle"]); return Promise.resolve(h.result) }
      /** With h.dataset set, evaluate the tuple-cursor filter + ordering like PostgREST would. */
      const evaluate = () => {
        if (!h.dataset) return h.result
        let rows = [...h.dataset].sort((x, y) => (x.created_at === y.created_at ? (x.id < y.id ? 1 : -1) : x.created_at < y.created_at ? 1 : -1))
        if (state.or) {
          const m = /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\."([^"]+)"\)$/.exec(state.or)
          if (!m) throw new Error(`unexpected or filter: ${state.or}`)
          const [, c, c2, id] = m
          rows = rows.filter(r => r.created_at < c || (r.created_at === c2 && r.id < id))
        }
        return { data: rows.slice(0, state.limit), error: null }
      }
      b.then = (res: any, rej: any) => Promise.resolve().then(evaluate).then(res, rej)
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
  h.dataset = null
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
  it("filters: direction, problemsOnly, tuple cursor (created_at, id), ordered by created_at then id", async () => {
    const c = "2026-10-07T10:00:00.123456+00:00"
    const id = "00000000-0000-4000-8000-000000000009"
    await list(`?direction=outbound_callback&problemsOnly=1&before=${encodeURIComponent(`${c}|${id}`)}&limit=10`)
    expect(call("eq")).toEqual([["eq", "direction", "outbound_callback"], ["eq", "ok", false]])
    expect(call("lt")).toEqual([])
    expect(call("or")).toEqual([["or", `created_at.lt."${c}",and(created_at.eq."${c}",id.lt."${id}")`]])
    expect(call("order")).toEqual([["order", "created_at", { ascending: false }], ["order", "id", { ascending: false }]])
    expect(call("limit")[0]).toEqual(["limit", 11])
  })
  it("nextBefore is '<raw created_at>|<id>' of the last row when there are more rows", async () => {
    h.result = { data: [row(3), row(2), row(1)], error: null }
    const json = await (await list("?limit=2")).json()
    expect(json.logs).toEqual([row(3), row(2)])
    expect(json.nextBefore).toBe(`${row(2).created_at}|${row(2).id}`)
  })
  it("paging across identical and microsecond timestamps never skips or duplicates a row", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `00000000-0000-4000-8000-0000000000${String(10 + i)}`)
    const ts = [
      "2026-10-07T10:00:00.123457+00:00", "2026-10-07T10:00:00.123456+00:00", "2026-10-07T10:00:00.123456+00:00",
      "2026-10-07T10:00:00.123456+00:00", "2026-10-07T10:00:00.123456+00:00", "2026-10-07T10:00:00.123455+00:00",
      "2026-10-07T10:00:00.123455+00:00", "2026-10-07T09:59:59.999999+00:00", "2026-10-07T09:59:59.999999+00:00",
    ]
    h.dataset = ids.map((id, i) => ({ ...row(1), id, created_at: ts[i] }))
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const json = await (await list(`?limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`)).json()
      seen.push(...json.logs.map((l: { id: string }) => l.id))
      cursor = json.nextBefore
      if (!cursor) break
    }
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.sort()).toEqual([...ids].sort())
  })
  it("400s on bad params or a malformed cursor; nothing queried", async () => {
    const goodTs = "2026-10-07T10:00:00.123456+00:00"
    const goodId = "00000000-0000-4000-8000-000000000001"
    const cursors = [
      "yesterday", goodTs, `${goodTs}|`, `|${goodId}`, `${goodTs}|nope`, `2026-10-07|${goodId}`,
      `${goodTs}"),id.gt.0|${goodId}`, `${goodTs}|${goodId}|x`, `2026-10-07T10:00:00,1|${goodId}`,
    ]
    for (const c of cursors) {
      const res = await list(`?before=${encodeURIComponent(c)}`)
      expect(res.status, c).toBe(400)
    }
    for (const qs of ["?limit=0", "?limit=101", "?limit=abc", "?limit=2.5", "?direction=sideways", "?problemsOnly=maybe"]) {
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
