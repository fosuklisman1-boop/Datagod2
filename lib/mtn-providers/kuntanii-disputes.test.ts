import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn() } }))

import {
  normaliseDisputeStatus,
  fileNotReceived,
  refreshDispute,
  refreshOpenDisputes,
  refreshStaleDisputes,
} from "./kuntanii-disputes"

type Row = Record<string, any>

// Tiny in-memory fake covering the chain methods the lib uses.
function makeDb(seed: { tracking?: Row[]; reports?: Row[]; insertError?: any } = {}) {
  const tables: Record<string, Row[]> = {
    mtn_fulfillment_tracking: seed.tracking ?? [],
    kuntanii_not_received_reports: seed.reports ?? [],
  }
  let nextId = 1
  const log = { inserts: [] as Row[], updates: [] as Row[], deletes: [] as string[], limits: [] as number[] }

  function from(table: string) {
    const rows = tables[table]
    let filters: Array<(r: Row) => boolean> = []
    let op: "select" | "insert" | "update" | "delete" = "select"
    let payload: Row = {}
    let limitN: number | undefined
    let single = false

    const run = () => {
      if (op === "insert") {
        if (seed.insertError) return { data: null, error: seed.insertError }
        const row = { id: `rep-${nextId++}`, last_checked_at: null, report_reference: null, ...payload }
        rows.push(row)
        log.inserts.push(row)
        return { data: { id: row.id }, error: null }
      }
      const matched = rows.filter((r) => filters.every((f) => f(r)))
      if (op === "update") {
        matched.forEach((r) => Object.assign(r, payload))
        log.updates.push(payload)
        return { data: null, error: null }
      }
      if (op === "delete") {
        matched.forEach((r) => {
          rows.splice(rows.indexOf(r), 1)
          log.deletes.push(r.id)
        })
        return { data: null, error: null }
      }
      let out = matched
      if (limitN !== undefined) {
        out = out.slice(0, limitN)
        log.limits.push(limitN)
      }
      return { data: single ? (out[0] ?? null) : out, error: null }
    }

    const b: any = {
      select: () => b,
      insert: (p: Row) => ((op = "insert"), (payload = p), b),
      update: (p: Row) => ((op = "update"), (payload = p), b),
      delete: () => ((op = "delete"), b),
      eq: (c: string, v: any) => (filters.push((r) => r[c] === v), b),
      in: (c: string, vs: any[]) => (filters.push((r) => vs.includes(r[c])), b),
      not: (c: string, _o: string, v: any) => (filters.push((r) => r[c] !== v), b),
      or: (expr: string) => {
        const m = /last_checked_at\.lt\.(.+)$/.exec(expr)!
        filters.push((r) => r.last_checked_at == null || r.last_checked_at < m[1])
        return b
      },
      order: () => b,
      limit: (n: number) => ((limitN = n), b),
      maybeSingle: () => ((single = true), Promise.resolve(run())),
      single: () => ((single = true), Promise.resolve(run())),
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  return { db: { from }, tables, log }
}

const goodTracking = {
  id: "t1",
  provider: "kuntanii",
  status: "completed",
  mtn_order_id: "ext-1",
  recipient_phone: "233241234567",
  size_gb: 5,
}

function fakeClient(over: Partial<Record<string, any>> = {}) {
  return {
    reportNotReceived: vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { reportReference: "rpt-1", orderReference: "ord-1", disputeStatus: "Open", status: "not received" },
    })),
    getNotReceivedStatus: vi.fn(async () => ({ ok: true, status: 200, data: { status: "Resolved" } })),
    ...over,
  } as any
}

describe("normaliseDisputeStatus", () => {
  it("maps case-insensitively and rejects unknown", () => {
    expect(normaliseDisputeStatus("Escalated")).toBe("escalated")
    expect(normaliseDisputeStatus("weird")).toBeNull()
    expect(normaliseDisputeStatus(undefined)).toBeNull()
  })
})

describe("fileNotReceived", () => {
  const input = { trackingId: "t1", adminUserId: "admin-1" }

  it("404 on missing row", async () => {
    const { db } = makeDb()
    const client = fakeClient()
    const r = await fileNotReceived(input, { db, client })
    expect(r).toMatchObject({ ok: false, status: 404 })
    expect(client.reportNotReceived).not.toHaveBeenCalled()
  })

  it("refuses non-kuntanii (400)", async () => {
    const { db } = makeDb({ tracking: [{ ...goodTracking, provider: "bundleportal" }] })
    expect(await fileNotReceived(input, { db, client: fakeClient() })).toMatchObject({ ok: false, status: 400 })
  })

  it("refuses non-completed (400)", async () => {
    const { db } = makeDb({ tracking: [{ ...goodTracking, status: "pending" }] })
    expect(await fileNotReceived(input, { db, client: fakeClient() })).toMatchObject({ ok: false, status: 400 })
  })

  it("description over 500 chars -> 400", async () => {
    const { db } = makeDb({ tracking: [goodTracking] })
    const r = await fileNotReceived({ ...input, description: "x".repeat(501) }, { db, client: fakeClient() })
    expect(r).toMatchObject({ ok: false, status: 400 })
  })

  it("reasonCode over 50 chars -> 400", async () => {
    const { db } = makeDb({ tracking: [goodTracking] })
    const r = await fileNotReceived({ ...input, reasonCode: "x".repeat(51) }, { db, client: fakeClient() })
    expect(r).toMatchObject({ ok: false, status: 400 })
  })

  it("derives phone/size/id from the row, not input; stores report reference and dispute status", async () => {
    const { db, tables } = makeDb({ tracking: [goodTracking] })
    const client = fakeClient()
    const r = await fileNotReceived(
      { ...input, description: "nothing arrived", reasonCode: "NOT_RECEIVED", phoneNumber: "0500000000", dataGb: 99 } as any,
      { db, client }
    )
    expect(r).toEqual({ ok: true, reportReference: "rpt-1" })
    expect(client.reportNotReceived).toHaveBeenCalledWith("ext-1", {
      phoneNumber: "0241234567",
      dataGb: 5,
      reasonCode: "NOT_RECEIVED",
      description: "nothing arrived",
    })
    const row = tables.kuntanii_not_received_reports[0]
    expect(row).toMatchObject({ report_reference: "rpt-1", order_reference: "ord-1", dispute_status: "open", raised_by: "admin-1" })
    expect(typeof row.updated_at).toBe("string")
  })

  it("second filing while open -> 409 and the client is never called", async () => {
    const { db } = makeDb({ tracking: [goodTracking], insertError: { code: "23505", message: "dup" } })
    const client = fakeClient()
    const r = await fileNotReceived(input, { db, client })
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(client.reportNotReceived).not.toHaveBeenCalled()
  })

  it("API failure removes the claim row -> 502", async () => {
    const { db, tables } = makeDb({ tracking: [goodTracking] })
    const client = fakeClient({
      reportNotReceived: vi.fn(async () => ({ ok: false, status: 500, code: "boom", message: "x" })),
    })
    const r = await fileNotReceived(input, { db, client })
    expect(r).toMatchObject({ ok: false, status: 502, code: "boom" })
    expect(tables.kuntanii_not_received_reports).toHaveLength(0)
  })

  it("client throwing also removes the claim -> 502", async () => {
    const { db, tables } = makeDb({ tracking: [goodTracking] })
    const client = fakeClient({ reportNotReceived: vi.fn(async () => { throw new Error("net") }) })
    expect(await fileNotReceived(input, { db, client })).toMatchObject({ ok: false, status: 502 })
    expect(tables.kuntanii_not_received_reports).toHaveLength(0)
  })
})

describe("refresh", () => {
  const rep = (over: Row) => ({
    id: "r1",
    tracking_id: "t1",
    external_order_id: "ext-1",
    report_reference: "rpt-1",
    dispute_status: "open",
    last_checked_at: null,
    ...over,
  })

  it("refreshDispute updates dispute_status, last_checked_at and updated_at", async () => {
    const { db, tables } = makeDb({ reports: [rep({})] })
    const client = fakeClient()
    expect(await refreshDispute("r1", { db, client })).toBe("resolved")
    expect(client.getNotReceivedStatus).toHaveBeenCalledWith("ext-1", "rpt-1")
    expect(tables.kuntanii_not_received_reports[0]).toMatchObject({ dispute_status: "resolved" })
    expect(tables.kuntanii_not_received_reports[0].last_checked_at).toBeTruthy()
    expect(tables.kuntanii_not_received_reports[0].updated_at).toBeTruthy()
  })

  it("refreshDispute returns null for a placeholder row without report_reference", async () => {
    const { db } = makeDb({ reports: [rep({ report_reference: null })] })
    const client = fakeClient()
    expect(await refreshDispute("r1", { db, client })).toBeNull()
    expect(client.getNotReceivedStatus).not.toHaveBeenCalled()
  })

  it("refreshOpenDisputes only touches open/escalated rows of that tracking", async () => {
    const { db } = makeDb({
      reports: [
        rep({ id: "a" }),
        rep({ id: "b", dispute_status: "escalated" }),
        rep({ id: "c", dispute_status: "resolved" }),
        rep({ id: "d", tracking_id: "other" }),
        rep({ id: "e", report_reference: null }),
      ],
    })
    const client = fakeClient()
    await refreshOpenDisputes("t1", { db, client })
    expect(client.getNotReceivedStatus).toHaveBeenCalledTimes(2)
  })

  it("refreshStaleDisputes respects limit and skips recently-checked rows", async () => {
    const fresh = new Date().toISOString()
    const old = new Date(Date.now() - 3_600_000).toISOString()
    const { db } = makeDb({
      reports: [
        rep({ id: "a" }),
        rep({ id: "b", last_checked_at: old }),
        rep({ id: "c", last_checked_at: old }),
        rep({ id: "d", last_checked_at: fresh }),
      ],
    })
    const client = fakeClient()
    const n = await refreshStaleDisputes(2, 600_000, { db, client })
    expect(n).toBe(2)
    expect(client.getNotReceivedStatus).toHaveBeenCalledTimes(2)
  })
})
