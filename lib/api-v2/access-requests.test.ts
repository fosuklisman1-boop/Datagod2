import { describe, it, expect } from "vitest"
import { cancelAccessRequest, createAccessRequest, shouldAlertForKey } from "./access-requests"

const NOW = new Date("2026-11-22T12:00:00Z")
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()

type FakeOpts = {
  rows?: any[]
  selectError?: boolean
  inserts?: Array<{ error?: any }>
  updated?: any[]
  updateError?: boolean
  count?: number
  countError?: boolean
}

/** Fake client: `rows` answers selects, `inserts` is a queue of insert results; every call is recorded. */
function fake(o: FakeOpts = {}) {
  const calls: any[] = []
  const inserts = [...(o.inserts ?? [{}])]
  const client = {
    from(table: string) {
      const rec: any = { table, op: "select", filters: [] as any[] }
      calls.push(rec)
      const result = () => {
        if (rec.op === "insert") {
          const r = inserts.shift() ?? {}
          return r.error ? { data: null, error: r.error } : { data: { id: "req-1", request_code: rec.payload.request_code }, error: null }
        }
        if (rec.op === "update") return o.updateError ? { data: null, error: { message: "x" } } : { data: o.updated ?? [], error: null }
        if (rec.head) return o.countError ? { count: null, error: { message: "x" } } : { count: o.count ?? 0, error: null }
        return o.selectError ? { data: null, error: { message: "x" } } : { data: o.rows ?? [], error: null }
      }
      const b: any = {
        select(c: string, opts?: any) { rec.cols = c; if (opts?.head) rec.head = true; return b },
        insert(p: any) { rec.op = "insert"; rec.payload = p; return b },
        update(p: any) { rec.op = "update"; rec.payload = p; return b },
        eq(c: string, v: any) { rec.filters.push(["eq", c, v]); return b },
        neq(c: string, v: any) { rec.filters.push(["neq", c, v]); return b },
        gte(c: string, v: any) { rec.filters.push(["gte", c, v]); return b },
        order() { return b },
        limit() { return b },
        single() { return Promise.resolve(result()) },
        then(res: any, rej: any) { return Promise.resolve(result()).then(res, rej) },
      }
      return b
    },
  }
  return { client, calls }
}

const CODE_DUP = { error: { code: "23505", message: 'duplicate key value violates unique constraint "api_v2_access_requests_request_code_key"' } }
const PENDING_DUP = { error: { code: "23505", message: 'duplicate key value violates unique constraint "api_v2_access_requests_one_pending_per_user"' } }

describe("createAccessRequest", () => {
  it("inserts a pending request with a fresh code for the given user and alerts", async () => {
    const { client, calls } = fake()
    const r = await createAccessRequest(client, "u1", NOW, () => "API-AAAAAA")
    expect(r).toEqual({ ok: true, id: "req-1", code: "API-AAAAAA", alert: true })
    expect(calls.find((c) => c.op === "insert").payload).toEqual({ user_id: "u1", request_code: "API-AAAAAA", status: "pending" })
  })

  it("an open request is 409 and inserts nothing", async () => {
    const { client, calls } = fake({ rows: [{ status: "pending", created_at: hoursAgo(1) }] })
    expect(await createAccessRequest(client, "u1", NOW)).toEqual({ ok: false, status: 409 })
    expect(calls.some((c) => c.op === "insert")).toBe(false)
  })

  it("rejected 23 h ago is 429 with the retry time; 25 h ago is allowed", async () => {
    const r23 = await createAccessRequest(fake({ rows: [{ status: "rejected", created_at: hoursAgo(30), decided_at: hoursAgo(23) }] }).client, "u1", NOW)
    expect(r23).toEqual({ ok: false, status: 429, retryAt: new Date(NOW.getTime() + 3600_000).toISOString() })
    const r25 = await createAccessRequest(fake({ rows: [{ status: "rejected", created_at: hoursAgo(30), decided_at: hoursAgo(25) }] }).client, "u1", NOW)
    expect(r25.ok).toBe(true)
  })

  it("request, cancel, request inside 24 h: allowed but no second alert", async () => {
    const r = await createAccessRequest(fake({ rows: [{ status: "cancelled", created_at: hoursAgo(2), decided_at: hoursAgo(1) }] }).client, "u1", NOW)
    expect(r).toMatchObject({ ok: true, alert: false })
  })

  it("retries a request_code collision up to 3 attempts, then 500", async () => {
    expect((await createAccessRequest(fake({ inserts: [CODE_DUP, CODE_DUP, {}] }).client, "u1", NOW)).ok).toBe(true)
    expect(await createAccessRequest(fake({ inserts: [CODE_DUP, CODE_DUP, CODE_DUP] }).client, "u1", NOW)).toEqual({ ok: false, status: 500 })
  })

  it("a concurrent second pending request (unique index) is 409", async () => {
    expect(await createAccessRequest(fake({ inserts: [PENDING_DUP] }).client, "u1", NOW)).toEqual({ ok: false, status: 409 })
  })

  it("a read or insert error is 500", async () => {
    expect(await createAccessRequest(fake({ selectError: true }).client, "u1", NOW)).toEqual({ ok: false, status: 500 })
    expect(await createAccessRequest(fake({ inserts: [{ error: { code: "XX000" } }] }).client, "u1", NOW)).toEqual({ ok: false, status: 500 })
  })
})

describe("cancelAccessRequest", () => {
  it("cancels only the caller's pending row", async () => {
    const { client, calls } = fake({ updated: [{ id: "req-1" }] })
    expect(await cancelAccessRequest(client, "u1")).toBe("cancelled")
    const up = calls.find((c) => c.op === "update")
    expect(up.payload.status).toBe("cancelled")
    expect(up.filters).toEqual(expect.arrayContaining([["eq", "user_id", "u1"], ["eq", "status", "pending"]]))
  })

  it("none when nothing was pending, error on a failed update", async () => {
    expect(await cancelAccessRequest(fake({ updated: [] }).client, "u1")).toBe("none")
    expect(await cancelAccessRequest(fake({ updateError: true }).client, "u1")).toBe("error")
  })
})

describe("shouldAlertForKey", () => {
  const p = { userId: "u1", type: "standard" as const, env: "live" as const, keyId: "k2", now: NOW }

  it("alerts when no other key in the slot was created in the last 24 h", async () => {
    const { client, calls } = fake({ count: 0 })
    expect(await shouldAlertForKey(client, p)).toBe(true)
    expect(calls[0].filters).toEqual(
      expect.arrayContaining([
        ["eq", "user_id", "u1"], ["eq", "key_type", "standard"], ["eq", "environment", "live"],
        ["neq", "id", "k2"], ["gte", "created_at", hoursAgo(24)],
      ]),
    )
  })

  it("does not alert for a second request in the slot within 24 h", async () => {
    expect(await shouldAlertForKey(fake({ count: 1 }).client, p)).toBe(false)
  })

  it("alerts when the check itself fails (never silently drop a request)", async () => {
    expect(await shouldAlertForKey(fake({ countError: true }).client, p)).toBe(true)
  })
})
