import { describe, it, expect, vi } from "vitest"
import { listDueHubtelPayments, runHubtelPaymentsSweep, SWEEP_LIMIT, type DueRow } from "./sweep"

const NOW = new Date("2026-11-04T10:00:00.000Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const MIN = 60_000
const ref = (n: number) => n.toString(16).padStart(32, "0")

interface Row { reference: string; status: string; created_at: string; claimed_at: string | null }

/**
 * Tiny PostgREST emulator over an in-memory table: supports the chain the sweep uses
 * (from/select/eq/lt/order/limit) and actually applies it, so eligibility is tested end to end.
 */
function fakeDb(rows: Row[], opts: { error?: string } = {}) {
  const calls: string[] = []
  const db = {
    from(table: string) {
      calls.push(`from:${table}`)
      const filters: ((r: Row) => boolean)[] = []
      let orderCol: keyof Row | null = null
      let asc = true
      let lim = Infinity
      const q: any = {
        select(cols: string) { calls.push(`select:${cols}`); return q },
        eq(col: keyof Row, v: string) { calls.push(`eq:${String(col)}=${v}`); filters.push((r) => r[col] === v); return q },
        lt(col: keyof Row, v: string) {
          calls.push(`lt:${String(col)}<${v}`)
          // Postgres semantics: NULL < x is not true.
          filters.push((r) => r[col] !== null && new Date(r[col] as string).getTime() < new Date(v).getTime())
          return q
        },
        order(col: keyof Row, o: { ascending: boolean }) { orderCol = col; asc = o.ascending; return q },
        limit(n: number) { lim = n; return q },
        then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
          if (opts.error) return Promise.resolve({ data: null, error: { message: opts.error } }).then(resolve, reject)
          let out = rows.filter((r) => filters.every((f) => f(r)))
          if (orderCol) {
            const c = orderCol
            out = [...out].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (asc ? 1 : -1))
          }
          return Promise.resolve({ data: out.slice(0, lim).map((r) => ({ ...r })), error: null }).then(resolve, reject)
        },
      }
      return q
    },
  }
  return { db, calls }
}

describe("listDueHubtelPayments", () => {
  it("picks pending older than 5 min and confirming claimed more than 10 min ago; boundaries excluded", async () => {
    const rows: Row[] = [
      { reference: ref(1), status: "pending", created_at: ago(5 * MIN + 1), claimed_at: null }, // due
      { reference: ref(2), status: "pending", created_at: ago(5 * MIN), claimed_at: null }, // exactly 5 min: not yet
      { reference: ref(3), status: "pending", created_at: ago(4 * MIN), claimed_at: null }, // too fresh
      { reference: ref(4), status: "confirming", created_at: ago(60 * MIN), claimed_at: ago(10 * MIN + 1) }, // due
      { reference: ref(5), status: "confirming", created_at: ago(60 * MIN), claimed_at: ago(10 * MIN) }, // exactly 10: not yet
      { reference: ref(6), status: "confirming", created_at: ago(60 * MIN), claimed_at: ago(2 * MIN) }, // held
      { reference: ref(7), status: "confirming", created_at: ago(60 * MIN), claimed_at: null }, // no claim stamp
      { reference: ref(8), status: "paid", created_at: ago(60 * MIN), claimed_at: ago(30 * MIN) },
      { reference: ref(9), status: "failed", created_at: ago(60 * MIN), claimed_at: ago(30 * MIN) },
      { reference: ref(10), status: "needs_review", created_at: ago(60 * MIN), claimed_at: ago(30 * MIN) },
    ]
    const { db, calls } = fakeDb(rows)
    const due = await listDueHubtelPayments(db as any, NOW)
    expect(due.map((r) => r.reference)).toEqual([ref(4), ref(1)]) // oldest created first
    expect(calls.filter((c) => c.startsWith("from:"))).toEqual(["from:hubtel_payments", "from:hubtel_payments"])
    // A pending row 5 min old must not be confirming-filtered by claimed_at, and vice versa.
    expect(calls).toContain(`lt:created_at<${ago(5 * MIN)}`)
    expect(calls).toContain(`lt:claimed_at<${ago(10 * MIN)}`)
  })

  it("caps at 50, oldest first across both statuses", async () => {
    const rows: Row[] = []
    for (let i = 0; i < 40; i++) rows.push({ reference: ref(100 + i), status: "pending", created_at: ago((100 - i) * MIN), claimed_at: null })
    for (let i = 0; i < 40; i++) rows.push({ reference: ref(200 + i), status: "confirming", created_at: ago((200 - i) * MIN), claimed_at: ago(20 * MIN) })
    const { db } = fakeDb(rows)
    const due = await listDueHubtelPayments(db as any, NOW)
    expect(SWEEP_LIMIT).toBe(50)
    expect(due).toHaveLength(50)
    expect(due.slice(0, 40).every((r) => r.status === "confirming")).toBe(true)
    expect(due.slice(40).map((r) => r.reference)).toEqual(rows.slice(0, 10).map((r) => r.reference))
    const times = due.map((r) => new Date(r.created_at).getTime())
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it("throws on a database error (the route reports it)", async () => {
    const { db } = fakeDb([], { error: "boom" })
    await expect(listDueHubtelPayments(db as any, NOW)).rejects.toThrow(/boom/)
  })
})

describe("runHubtelPaymentsSweep", () => {
  const rows = (n: number): DueRow[] => Array.from({ length: n }, (_, i) => ({ reference: ref(i + 1), status: "pending", created_at: ago((n - i) * MIN) }))

  it("confirms each row one at a time and counts outcomes", async () => {
    const outcomes = ["fulfilled", "failed", "pending", "needs_review", "ignored", "fulfilled"] as const
    let inFlight = 0
    let maxInFlight = 0
    const confirm = vi.fn(async (r: string) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((res) => setTimeout(res, 1))
      inFlight--
      return outcomes[parseInt(r, 16) - 1]
    })
    const listDue = vi.fn(async () => rows(6))
    const out = await runHubtelPaymentsSweep({ listDue, confirm, now: () => NOW })
    expect(listDue).toHaveBeenCalledWith(NOW)
    expect(confirm.mock.calls.map((c) => c[0])).toEqual(rows(6).map((r) => r.reference))
    expect(maxInFlight).toBe(1)
    expect(out).toEqual({ processed: 6, outcomes: { fulfilled: 2, failed: 1, pending: 1, needs_review: 1, ignored: 1, error: 0 } })
  })

  it("one row throwing does not stop the rest; it counts as error", async () => {
    const confirm = vi.fn(async (r: string) => {
      if (r === ref(2)) throw new Error("store down")
      return "pending" as const
    })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const out = await runHubtelPaymentsSweep({ listDue: async () => rows(3), confirm, now: () => NOW })
    expect(confirm).toHaveBeenCalledTimes(3)
    expect(out).toEqual({ processed: 3, outcomes: { fulfilled: 0, failed: 0, pending: 2, needs_review: 0, ignored: 0, error: 1 } })
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it("no due rows → processed 0, all zero", async () => {
    const confirm = vi.fn()
    const out = await runHubtelPaymentsSweep({ listDue: async () => [], confirm, now: () => NOW })
    expect(confirm).not.toHaveBeenCalled()
    expect(out).toEqual({ processed: 0, outcomes: { fulfilled: 0, failed: 0, pending: 0, needs_review: 0, ignored: 0, error: 0 } })
  })
})
