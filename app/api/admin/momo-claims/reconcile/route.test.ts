import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

type Op = { method: string; args: unknown[] }
type Call = { table: string; ops: Op[] }
let calls: Call[] = []
let handler: (c: Call) => { data?: unknown; error?: unknown }

function chain(table: string) {
  const call: Call = { table, ops: [] }
  calls.push(call)
  const proxy: Record<string, unknown> = {}
  for (const m of ["select", "eq", "gte", "lte", "order", "range", "limit", "insert", "single"]) {
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
const notifyMock = vi.fn()
vi.mock("@/lib/admin-actions/momo-claim", () => ({ notifyMomoAdmins: (...a: unknown[]) => notifyMock(...a) }))

import { GET, POST } from "./route"

const URL_ = "http://localhost/api/admin/momo-claims/reconcile"
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const post = (body: unknown) =>
  new NextRequest(URL_, {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(body),
  })
const get = () => new NextRequest(URL_, { method: "GET", headers: { authorization: "Bearer tok" } })

const CSV = "Date,Transaction ID\n2026-11-01,12345678901\n2026-11-01,12345678902\n"
const GOOD = { csv: CSV, column: "Transaction ID", periodStart: "2026-11-01", periodEnd: "2026-11-02" }

let claimedRows: { transaction_id: string; claimed_at: string }[]
let insertError: unknown
let runRows: unknown[]

beforeEach(() => {
  calls = []
  notifyMock.mockReset()
  authMock.mockReset().mockResolvedValue({ isAdmin: true, userId: ADMIN })
  claimedRows = [
    { transaction_id: "12345678901", claimed_at: "2026-11-01T10:00:00Z" },
    { transaction_id: "99999999999", claimed_at: "2026-11-02T10:00:00Z" },
  ]
  insertError = null
  runRows = []
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x"
  handler = (c) => {
    const has = (m: string) => c.ops.some((o) => o.method === m)
    if (c.table === "momo_transactions") {
      const r = c.ops.find((o) => o.method === "range")?.args as [number, number] | undefined
      const [a, b] = r ?? [0, claimedRows.length]
      return { data: claimedRows.slice(a, b + 1), error: null }
    }
    if (c.table === "momo_reconciliation_runs") {
      if (has("insert")) return insertError ? { error: insertError } : { data: { id: "run-1" }, error: null }
      return { data: runRows, error: null }
    }
    return { data: null, error: null }
  }
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("POST /api/admin/momo-claims/reconcile", () => {
  it("rejects non-admins", async () => {
    authMock.mockResolvedValue({ isAdmin: false })
    expect((await POST(post(GOOD))).status).toBe(403)
  })

  it("requires a real admin user id", async () => {
    authMock.mockResolvedValue({ isAdmin: true })
    const res = await POST(post(GOOD))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("admin_user_required")
  })

  it("reports missing claims, stores a run and alerts with a count only", async () => {
    const res = await POST(post(GOOD))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ runId: "run-1", statementTxids: 2, claimedChecked: 2, missing: ["99999999999"] })
    const ins = calls.find((c) => c.table === "momo_reconciliation_runs")!.ops.find((o) => o.method === "insert")!.args[0] as Record<string, unknown>
    expect(ins).toMatchObject({
      admin_id: ADMIN,
      period_start: "2026-11-01",
      period_end: "2026-11-02",
      statement_txids: 2,
      claimed_checked: 2,
      missing_txids: ["99999999999"],
    })
    expect(notifyMock).toHaveBeenCalledTimes(1)
    const alert = notifyMock.mock.calls[0][0]
    expect(alert).toEqual({ kind: "reconciliation_missing", reasons: ["1 missing"] })
    expect(JSON.stringify(alert)).not.toContain("99999999999")
  })

  it("does not alert when nothing is missing", async () => {
    claimedRows = [{ transaction_id: "12345678901", claimed_at: "2026-11-01T10:00:00Z" }]
    const res = await POST(post(GOOD))
    expect((await res.json()).missing).toEqual([])
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it("queries claimed rows in the period and paginates past 1000", async () => {
    claimedRows = Array.from({ length: 1500 }, (_, i) => ({
      transaction_id: String(20000000000 + i),
      claimed_at: "2026-11-01T10:00:00Z",
    }))
    const res = await POST(post(GOOD))
    const body = await res.json()
    expect(body.claimedChecked).toBe(1500)
    const mt = calls.filter((c) => c.table === "momo_transactions")
    expect(mt).toHaveLength(2)
    expect(mt[0].ops.find((o) => o.method === "range")!.args).toEqual([0, 999])
    expect(mt[1].ops.find((o) => o.method === "range")!.args).toEqual([1000, 1999])
    const first = mt[0].ops
    expect(first.find((o) => o.method === "eq")!.args).toEqual(["status", "claimed"])
    expect(first.find((o) => o.method === "gte")!.args).toEqual(["claimed_at", "2026-11-01T00:00:00.000Z"])
    expect(first.find((o) => o.method === "lte")!.args).toEqual(["claimed_at", "2026-11-02T23:59:59.999Z"])
  })

  it("400 unknown_column", async () => {
    const res = await POST(post({ ...GOOD, column: "Nope" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("unknown_column")
  })

  it("413 for a CSV over 5 MB", async () => {
    const res = await POST(post({ ...GOOD, csv: "x".repeat(5 * 1024 * 1024 + 1) }))
    expect(res.status).toBe(413)
  })

  it("400 for bad body, dates, order and span", async () => {
    for (const b of [
      { ...GOOD, csv: 5 },
      { ...GOOD, column: "" },
      { ...GOOD, periodStart: "2026-13-01" },
      { ...GOOD, periodStart: "2026-02-31" },
      { ...GOOD, periodStart: "11/01/2026" },
      { ...GOOD, periodStart: "2026-11-03", periodEnd: "2026-11-02" },
      { ...GOOD, periodStart: "2026-01-01", periodEnd: "2026-03-30" },
    ]) {
      expect((await POST(post(b))).status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })

  // The span counts both end days: 2026-09-01..2026-11-01 is 62 calendar days (accepted), one more day is 63 (rejected).
  it("accepts a 62-day inclusive span and rejects 63", async () => {
    const ok = await POST(post({ ...GOOD, periodStart: "2026-09-01", periodEnd: "2026-11-01" }))
    expect(ok.status).toBe(200)
    const tooLong = await POST(post({ ...GOOD, periodStart: "2026-09-01", periodEnd: "2026-11-02" }))
    expect(tooLong.status).toBe(400)
  })

  it("insert failure still alerts on missing ids and returns them with run_not_saved; logs no ids", async () => {
    insertError = { code: "XX000", message: "99999999999 secret" }
    const res = await POST(post(GOOD))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "run_not_saved", missing: ["99999999999"] })
    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(notifyMock.mock.calls[0][0]).toEqual({ kind: "reconciliation_missing", reasons: ["1 missing"] })
    expect(JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls)).not.toContain("99999999999")
  })

  it("insert failure with nothing missing returns plain run_not_saved without an alert", async () => {
    insertError = { code: "XX000" }
    claimedRows = [{ transaction_id: "12345678901", claimed_at: "2026-11-01T10:00:00Z" }]
    const res = await POST(post(GOOD))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "run_not_saved", missing: [] })
    expect(notifyMock).not.toHaveBeenCalled()
  })
})

describe("GET /api/admin/momo-claims/reconcile", () => {
  it("returns the latest 20 runs with long missing lists truncated", async () => {
    const long = Array.from({ length: 300 }, (_, i) => String(10000000000 + i))
    runRows = [{ id: "r1", missing_txids: long, claimed_checked: 5 }, { id: "r2", missing_txids: ["12345678901"] }]
    const res = await GET(get())
    expect(res.status).toBe(200)
    const { runs } = await res.json()
    expect(runs[0].missingCount).toBe(300)
    expect(runs[0].missing_txids).toHaveLength(200)
    expect(runs[1].missingCount).toBe(1)
    const c = calls.find((x) => x.table === "momo_reconciliation_runs")!
    expect(c.ops.find((o) => o.method === "order")!.args[0]).toBe("created_at")
    expect(c.ops.find((o) => o.method === "limit")!.args[0]).toBe(20)
  })

  it("rejects non-admins", async () => {
    authMock.mockResolvedValue({ isAdmin: false })
    expect((await GET(get())).status).toBe(403)
  })
})
