// lib/ussd-hubtel/wallet-pay.test.ts
import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  WALLET_SOURCE,
  WALLET_SWEEP_LEASE_MS,
  WALLET_SWEEP_LIMIT,
  WALLET_SWEEP_MIN_AGE_MS,
  findWalletPaymentBySession,
  payFromWallet,
  runWalletPostPayment,
  sweepWalletPayments,
  type WalletTable,
} from "./wallet-pay"

const NOW = Date.parse("2026-11-07T12:00:00Z")
const OLD = new Date(NOW - WALLET_SWEEP_MIN_AGE_MS - 1000).toISOString()
const FRESH = new Date(NOW - WALLET_SWEEP_MIN_AGE_MS + 1000).toISOString()
const PHONE = "0241234567"

type Row = Record<string, any>
type DbOpts = {
  rpc?: (fn: string, args: any) => { data: any; error: any } | Promise<{ data: any; error: any }>
  readError?: any
  readThrows?: boolean
  listError?: any
  updateError?: (id: string, patch: Row) => any
  updateThrows?: (id: string, patch: Row) => boolean
}

/** In-memory hubtel_wallet_payments. It has no insert or delete: only the RPC inserts, and nobody deletes. */
function fakeDb(rows: Row[] = [], opts: DbOpts = {}) {
  const calls = { rpc: [] as any[], updates: [] as { filters: [string, any][]; patch: Row }[], lists: 0 }
  const from = (table: string) => {
    expect(table).toBe("hubtel_wallet_payments")
    const q = {
      filters: [] as [string, any][],
      before: [] as [string, string][],
      patch: null as Row | null,
      max: Infinity,
      ordered: false,
      select: () => q,
      eq: (c: string, v: any) => { q.filters.push([c, v]); return q },
      lt: (c: string, v: string) => { q.before.push([c, v]); return q },
      order: () => { q.ordered = true; return q },
      limit: (n: number) => { q.max = n; return q },
      update: (p: Row) => { q.patch = p; return q },
      matching: () => {
        let out = rows.filter(r => q.filters.every(([c, v]) => r[c] === v))
        out = out.filter(r => q.before.every(([c, v]) => r[c] < v))
        if (q.ordered) out = [...out].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
        return out.slice(0, q.max)
      },
      maybeSingle: async () => {
        if (opts.readThrows) throw new Error("fetch failed")
        if (opts.readError) return { data: null, error: opts.readError }
        return { data: q.matching()[0] ?? null, error: null }
      },
      then: (res: (v: any) => any, rej: (e: any) => any) => run().then(res, rej),
    }
    const run = async () => {
      if (q.patch) {
        const id = q.filters.find(([c]) => c === "id")?.[1]
        calls.updates.push({ filters: q.filters, patch: q.patch })
        if (opts.updateThrows?.(id, q.patch)) throw new Error("fetch failed")
        const err = opts.updateError?.(id, q.patch)
        if (err) return { data: null, error: err }
        const hit = q.matching()
        hit.forEach(r => Object.assign(r, q.patch))
        return { data: hit, error: null }
      }
      calls.lists++
      if (opts.listError) return { data: null, error: opts.listError }
      return { data: q.matching(), error: null }
    }
    return q
  }
  const rpc = async (fn: string, args: any) => {
    calls.rpc.push({ fn, args })
    return opts.rpc ? opts.rpc(fn, args) : { data: { payment_id: "pay-1", replay: false, new_balance: 10 }, error: null }
  }
  return { client: { from, rpc } as any, calls }
}

const input = (over: Partial<Parameters<typeof payFromWallet>[1]> = {}) => ({
  sessionId: "S1",
  userId: "U1",
  table: "ussd_orders" as WalletTable,
  orderId: "O1",
  amount: 12.5,
  description: `Data for ${PHONE}`,
  ...over,
})

const payRow = (over: Row = {}): Row => ({
  id: "pay-1",
  session_id: "S1",
  order_table: "ussd_orders",
  order_id: "O1",
  user_id: "U1",
  amount: 12.5,
  state: "debited",
  review_reason: null,
  created_at: OLD,
  updated_at: OLD,
  ...over,
})

const rpcError = (message: string, extra: Row = {}) => () => ({ data: null, error: { code: "P0001", message, ...extra } })

let errorLog: ReturnType<typeof vi.spyOn>
let warnLog: ReturnType<typeof vi.spyOn>
const logged = () => JSON.stringify([...errorLog.mock.calls, ...warnLog.mock.calls])

beforeEach(() => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
  warnLog = vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("WALLET_SOURCE", () => {
  it("names the history source for each order table", () => {
    expect(WALLET_SOURCE).toEqual({
      ussd_orders: "ussd_data_purchase",
      airtime_orders: "airtime_purchase",
      results_checker_orders: "ussd_results_checker",
      results_check_requests: "results_check_request",
    })
  })
})

describe("payFromWallet", () => {
  it.each(Object.entries(WALLET_SOURCE))("paid: %s calls the RPC with source %s", async (table, source) => {
    const handler = vi.fn(async () => {})
    const alert = vi.fn(async () => {})
    const { client, calls } = fakeDb()
    const r = await payFromWallet({ db: client, handlers: { [table]: handler }, alert }, input({ table: table as WalletTable }))
    expect(r).toEqual({ kind: "paid", paymentId: "pay-1" })
    expect(calls.rpc).toEqual([{
      fn: "pay_hubtel_order_from_wallet",
      args: {
        p_session: "S1", p_user: "U1", p_table: table, p_order: "O1", p_amount: 12.5, p_source: source,
        p_description: `Data for ${PHONE}`,
      },
    }])
    // The caller runs post-payment (in the background): this call never does.
    expect(handler).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })

  it("INSUFFICIENT_FUNDS gives insufficient, with no read-back and no alert", async () => {
    const alert = vi.fn(async () => {})
    const { client, calls } = fakeDb([payRow()], { rpc: rpcError("INSUFFICIENT_FUNDS") })
    expect(await payFromWallet({ db: client, handlers: {}, alert }, input())).toEqual({ kind: "insufficient" })
    expect(alert).not.toHaveBeenCalled()
    expect(calls.lists).toBe(0)
  })

  it.each(["BAD_INPUT", "ALREADY_CARTED"])("%s gives refused, no read-back, no alert, ids only in the log", async name => {
    const alert = vi.fn(async () => {})
    const db = fakeDb([], { rpc: rpcError(name, { details: `Failing row contains (${PHONE})` }), readThrows: true })
    expect(await payFromWallet({ db: db.client, handlers: {}, alert }, input())).toEqual({ kind: "refused" })
    expect(alert).not.toHaveBeenCalled()
    expect(logged()).toContain("O1")
    expect(logged()).not.toContain(PHONE)
  })

  it("two orders on one session: O1 is paid, O2's BAD_INPUT is refused and its handler never runs", async () => {
    const rows: Row[] = []
    const rpc = (_: string, a: any) => {
      if (rows.length && rows[0].order_id !== a.p_order) return { data: null, error: { code: "P0001", message: "BAD_INPUT" } }
      rows.push(payRow({ order_id: a.p_order }))
      return { data: { payment_id: "pay-1", replay: false, new_balance: 1 }, error: null }
    }
    const handler = vi.fn(async () => {})
    const deps = { db: fakeDb(rows, { rpc }).client, handlers: { ussd_orders: handler }, alert: vi.fn(async () => {}) }
    const first = await payFromWallet(deps, input())
    expect(first.kind).toBe("paid")
    await runWalletPostPayment(deps, first.paymentId!, "ussd_orders", "O1")
    expect(handler).toHaveBeenCalledTimes(1)

    expect(await payFromWallet(deps, input({ orderId: "O2" }))).toEqual({ kind: "refused" })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).not.toHaveBeenCalledWith("O2")
  })

  it("replay: true gives replay with the payment id, and post-payment is not run", async () => {
    const handler = vi.fn(async () => {})
    const { client } = fakeDb([], { rpc: () => ({ data: { payment_id: "pay-9", replay: true, new_balance: 3 }, error: null }) })
    const r = await payFromWallet({ db: client, handlers: { ussd_orders: handler }, alert: vi.fn(async () => {}) }, input())
    expect(r).toEqual({ kind: "replay", paymentId: "pay-9" })
    expect(handler).not.toHaveBeenCalled()
  })

  describe("unknown errors are read back by session", () => {
    const unknown = [
      ["a returned database error", rpcError("canceling statement due to statement timeout", { code: "57014" })],
      ["a thrown transport failure", () => { throw new TypeError("fetch failed") }],
      ["a success with no payment id", () => ({ data: null, error: null })],
    ] as const

    it.each(unknown)("%s, with a matching row, gives paid", async (_, rpc) => {
      const { client } = fakeDb([payRow({ id: "pay-7" })], { rpc })
      const r = await payFromWallet({ db: client, handlers: {}, alert: vi.fn(async () => {}) }, input())
      expect(r).toEqual({ kind: "paid", paymentId: "pay-7" })
    })

    it.each(unknown)("%s, with no row, gives unavailable and no alert: no debit, so the order can be failed", async (_, rpc) => {
      const alert = vi.fn(async () => {})
      const { client } = fakeDb([], { rpc })
      expect(await payFromWallet({ db: client, handlers: {}, alert }, input())).toEqual({ kind: "unavailable" })
      expect(alert).not.toHaveBeenCalled()
    })

    it.each([
      ["table", { order_table: "airtime_orders" }],
      ["order", { order_id: "O-other" }],
      ["user", { user_id: "U-other" }],
    ])("a row with a different %s gives refused, and no handler runs", async (_, over) => {
      const handler = vi.fn(async () => {})
      const { client } = fakeDb([payRow(over)], { rpc: rpcError("boom", { code: "57014" }) })
      const r = await payFromWallet({ db: client, handlers: { ussd_orders: handler, airtime_orders: handler }, alert: vi.fn(async () => {}) }, input())
      expect(r).toEqual({ kind: "refused" })
      expect(handler).not.toHaveBeenCalled()
    })

    it.each([
      ["returned", { readError: { code: "XX000", message: `read failed Failing row contains (${PHONE})`, details: PHONE } }],
      ["thrown", { readThrows: true }],
    ])("a %s read error gives unavailable with the debit marked uncertain, and an URGENT alert with no phone", async (_, over) => {
      const alert = vi.fn(async (_m: string) => {})
      const { client } = fakeDb([], { rpc: rpcError("boom", { code: "57014" }), ...over })
      const r = await payFromWallet({ db: client, handlers: {}, alert }, input())
      expect(r).toEqual({ kind: "unavailable", debitUncertain: true })
      expect(alert).toHaveBeenCalledTimes(1)
      const msg = alert.mock.calls[0][0]
      expect(msg).toMatch(/^URGENT/)
      expect(msg).toContain("ussd_orders")
      expect(msg).toContain("O1")
      expect(msg).toContain("12.50")
      expect(msg).not.toContain(PHONE)
      expect(logged()).not.toContain(PHONE)
    })

    it("an alert failing on that path is logged and does not throw", async () => {
      const { client } = fakeDb([], { rpc: rpcError("boom"), readThrows: true })
      const alert = vi.fn(async () => { throw new Error("sms down") })
      await expect(payFromWallet({ db: client, handlers: {}, alert }, input())).resolves.toEqual({ kind: "unavailable", debitUncertain: true })
      expect(logged()).toContain("sms down")
    })

    it("the database's row detail never reaches the log", async () => {
      const { client } = fakeDb([], { rpc: rpcError(`insert failed Failing row contains (${PHONE})`, { code: "23514", details: PHONE }) })
      await payFromWallet({ db: client, handlers: {}, alert: vi.fn(async () => {}) }, input())
      expect(errorLog).toHaveBeenCalled()
      expect(logged()).not.toContain(PHONE)
    })
  })
})

describe("findWalletPaymentBySession", () => {
  it("returns the row, or null", async () => {
    const { client } = fakeDb([payRow()])
    expect((await findWalletPaymentBySession(client, "S1"))?.id).toBe("pay-1")
    expect(await findWalletPaymentBySession(client, "S-none")).toBeNull()
  })

  it("throws a safe error on a read failure, so a failure is never read as no payment", async () => {
    const { client } = fakeDb([], { readError: { code: "XX000", message: `x Failing row contains (${PHONE})`, details: PHONE } })
    const err = await findWalletPaymentBySession(client, "S1").catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).not.toContain(PHONE)
  })
})

describe("runWalletPostPayment", () => {
  const run = (rows: Row[], handlers: any, alert: any = vi.fn(async () => {}), opts: DbOpts = {}) => {
    const db = fakeDb(rows, opts)
    return { db, alert, go: () => runWalletPostPayment({ db: db.client, handlers, alert }, "pay-1", "ussd_orders", "O1") }
  }

  it("the handler returning sets fulfilled, guarded on debited, with no alert", async () => {
    const rows = [payRow()]
    const handler = vi.fn(async () => {})
    const { db, alert, go } = run(rows, { ussd_orders: handler })
    await go()
    expect(handler).toHaveBeenCalledWith("O1")
    expect(rows[0].state).toBe("fulfilled")
    expect(db.calls.updates[0].filters).toEqual([["id", "pay-1"], ["state", "debited"]])
    expect(alert).not.toHaveBeenCalled()
  })

  it("the handler throwing sets needs_review with the reason stored, and an URGENT alert with the order and no phone", async () => {
    const rows = [payRow()]
    const handler = vi.fn(async () => { throw new Error(`ussd_orders O1 for ${PHONE} not in a payable state: failed`) })
    const alert = vi.fn(async (_m: string) => {})
    const { db, go } = run(rows, { ussd_orders: handler }, alert)
    await expect(go()).resolves.toBeUndefined()
    expect(rows[0].state).toBe("needs_review")
    expect(rows[0].review_reason).toContain("not in a payable state")
    expect(rows[0].review_reason).not.toContain(PHONE)
    expect(db.calls.updates[0].filters).toEqual([["id", "pay-1"], ["state", "debited"]])
    expect(alert).toHaveBeenCalledTimes(1)
    const msg = alert.mock.calls[0][0]
    expect(msg).toMatch(/^URGENT/)
    expect(msg).toContain("ussd_orders")
    expect(msg).toContain("O1")
    expect(msg).toContain("12.50")
    expect(msg).not.toContain(PHONE)
    // A reason category only: the handler's own text stays in the row.
    expect(msg).not.toContain("not in a payable state")
    expect(logged()).not.toContain(PHONE)
  })

  it("a raw database error from a handler stores and logs no row detail", async () => {
    const rows = [payRow()]
    const dbErr = { code: "23514", message: `new row violates Failing row contains (${PHONE})`, details: `(${PHONE})` }
    const { go } = run(rows, { ussd_orders: vi.fn(async () => { throw dbErr }) })
    await go()
    expect(rows[0].state).toBe("needs_review")
    expect(rows[0].review_reason).not.toContain(PHONE)
    expect(logged()).not.toContain(PHONE)
  })

  it("a table with no handler counts as a throw: needs_review and an URGENT alert", async () => {
    const rows = [payRow()]
    const alert = vi.fn(async (_m: string) => {})
    const { go } = run(rows, {}, alert)
    await expect(go()).resolves.toBeUndefined()
    expect(rows[0].state).toBe("needs_review")
    expect(rows[0].review_reason).toMatch(/no post-payment handler/i)
    expect(alert.mock.calls[0][0]).toMatch(/^URGENT/)
  })

  it("an alert failing is logged and does not throw", async () => {
    const rows = [payRow()]
    const alert = vi.fn(async () => { throw new Error("sms down") })
    const { go } = run(rows, { ussd_orders: vi.fn(async () => { throw new Error("boom") }) }, alert)
    await expect(go()).resolves.toBeUndefined()
    expect(rows[0].state).toBe("needs_review")
    expect(logged()).toContain("sms down")
  })

  it.each(["fulfilled", "needs_review"])("a row already %s is left alone: a success changes nothing", async state => {
    const rows = [payRow({ state, review_reason: "earlier" })]
    const { go } = run(rows, { ussd_orders: vi.fn(async () => {}) })
    await go()
    expect(rows[0].state).toBe(state)
    expect(rows[0].review_reason).toBe("earlier")
  })

  it("losing to another run that fulfilled the row: a throw overwrites nothing and raises no false alarm", async () => {
    const rows = [payRow({ state: "fulfilled" })]
    const alert = vi.fn(async () => {})
    const { go } = run(rows, { ussd_orders: vi.fn(async () => { throw new Error("lost the mark") }) }, alert)
    await go()
    expect(rows[0].state).toBe("fulfilled")
    expect(rows[0].review_reason).toBeNull()
    expect(alert).not.toHaveBeenCalled()
  })

  it.each([
    ["returned", { updateError: () => ({ code: "XX000", message: "down" }) }],
    ["thrown", { updateThrows: () => true }],
  ])("a %s write error after the handler failed still alerts: the money stays visible", async (_, opts) => {
    const rows = [payRow()]
    const alert = vi.fn(async (_m: string) => {})
    const { go } = run(rows, { ussd_orders: vi.fn(async () => { throw new Error("boom") }) }, alert, opts)
    await expect(go()).resolves.toBeUndefined()
    expect(rows[0].state).toBe("debited")
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert.mock.calls[0][0]).toMatch(/^URGENT/)
    expect(alert.mock.calls[0][0]).toContain("O1")
  })

  it.each([
    ["returned", { updateError: () => ({ code: "XX000", message: "down" }) }],
    ["thrown", { updateThrows: () => true }],
  ])("the amount passed in reaches the alert even when the %s state write failed", async (_, opts) => {
    const rows = [payRow()]
    const alert = vi.fn(async (_m: string) => {})
    const db = fakeDb(rows, opts)
    const handlers = { ussd_orders: vi.fn(async () => { throw new Error("boom") }) }
    await runWalletPostPayment({ db: db.client, handlers, alert }, "pay-1", "ussd_orders", "O1", 7.25)
    expect(alert.mock.calls[0][0]).toContain("GHS 7.25")
  })

  it.each([
    ["returned", { updateError: () => ({ code: "XX000", message: "down" }) }],
    ["thrown", { updateThrows: () => true }],
  ])("a %s write error after the handler succeeded is logged; the row stays debited for the sweep", async (_, opts) => {
    const rows = [payRow()]
    const alert = vi.fn(async () => {})
    const { go } = run(rows, { ussd_orders: vi.fn(async () => {}) }, alert, opts)
    await expect(go()).resolves.toBeUndefined()
    expect(rows[0].state).toBe("debited")
    expect(alert).not.toHaveBeenCalled()
    expect(errorLog).toHaveBeenCalled()
  })
})

describe("sweepWalletPayments", () => {
  const sweep = (db: any, handlers: any, alert: any = vi.fn(async () => {}), deadlineMs?: number) =>
    sweepWalletPayments(db, handlers, alert, NOW, deadlineMs)

  it("picks only debited rows older than 10 minutes", async () => {
    const rows = [
      payRow({ id: "old", order_id: "O-old" }),
      payRow({ id: "fresh", order_id: "O-fresh", created_at: FRESH }),
      payRow({ id: "done", order_id: "O-done", state: "fulfilled" }),
      payRow({ id: "review", order_id: "O-review", state: "needs_review" }),
    ]
    const handler = vi.fn(async () => {})
    expect(await sweep(fakeDb(rows).client, { ussd_orders: handler })).toEqual({ found: 1, fulfilled: 1, review: 0 })
    expect(handler.mock.calls).toEqual([["O-old"]])
    expect(rows.map(r => r.state)).toEqual(["fulfilled", "debited", "fulfilled", "needs_review"])
  })

  it("re-running against an order the handler finds completed ends in fulfilled", async () => {
    const rows = [payRow()]
    // A handler returns early on a completed order: returning normally is success.
    const alreadyCompleted = vi.fn(async () => {})
    expect(await sweep(fakeDb(rows).client, { ussd_orders: alreadyCompleted })).toEqual({ found: 1, fulfilled: 1, review: 0 })
    expect(rows[0].state).toBe("fulfilled")
  })

  it("a second failure ends in needs_review with an URGENT alert, and the row is not listed again", async () => {
    const rows = [payRow()]
    const handler = vi.fn(async () => { throw new Error("boom") })
    const alert = vi.fn(async (_m: string) => {})
    const { client } = fakeDb(rows)
    expect(await sweep(client, { ussd_orders: handler }, alert)).toEqual({ found: 1, fulfilled: 0, review: 1 })
    expect(rows[0].state).toBe("needs_review")
    expect(alert.mock.calls[0][0]).toMatch(/^URGENT/)
    expect(await sweep(client, { ussd_orders: handler }, alert)).toEqual({ found: 0, fulfilled: 0, review: 0 })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledTimes(1)
  })

  it("routes each row to its own table's handler", async () => {
    const rows = [payRow({ id: "a", order_table: "airtime_orders", order_id: "O-a" })]
    const airtime = vi.fn(async () => {})
    const data = vi.fn(async () => {})
    await sweep(fakeDb(rows).client, { ussd_orders: data, airtime_orders: airtime })
    expect(airtime).toHaveBeenCalledWith("O-a")
    expect(data).not.toHaveBeenCalled()
  })

  it("caps the rows per run, oldest first", async () => {
    const rows = Array.from({ length: WALLET_SWEEP_LIMIT + 5 }, (_, i) =>
      payRow({ id: `p${i}`, order_id: `O${i}`, created_at: new Date(NOW - WALLET_SWEEP_MIN_AGE_MS - 1000 - i * 1000).toISOString() }))
    const handler = vi.fn(async () => {})
    const res = await sweep(fakeDb(rows).client, { ussd_orders: handler })
    expect(WALLET_SWEEP_LIMIT).toBe(100)
    expect(res.found).toBe(100)
    expect(handler).toHaveBeenCalledTimes(100)
    expect(handler.mock.calls[0]).toEqual([`O${WALLET_SWEEP_LIMIT + 4}`])
  })

  it("one row's failure does not stop the others", async () => {
    const rows = [
      payRow({ id: "bad", order_id: "O-bad", created_at: new Date(NOW - 3_000_000).toISOString() }),
      payRow({ id: "unwritable", order_id: "O-unw", created_at: new Date(NOW - 2_000_000).toISOString() }),
      payRow({ id: "good", order_id: "O-good", created_at: new Date(NOW - 1_000_000).toISOString() }),
    ]
    const handler = vi.fn(async (id: string) => { if (id === "O-bad") throw new Error("boom") })
    const { client } = fakeDb(rows, { updateThrows: id => id === "unwritable" })
    const res = await sweep(client, { ussd_orders: handler })
    expect(res).toEqual({ found: 3, fulfilled: 1, review: 1 })
    expect(rows.find(r => r.id === "good")!.state).toBe("fulfilled")
  })

  it.each([
    ["returned", () => fakeDb([payRow()], { listError: { code: "XX000", message: `down ${PHONE}`, details: PHONE } }).client],
    ["thrown", () => ({ from: () => { throw new Error("client broke") } }) as any],
  ])("never throws on a %s list error, and raises no alert (it would repeat every run)", async (_, db) => {
    const alert = vi.fn(async () => {})
    await expect(sweep(db(), {}, alert)).resolves.toEqual({ found: 0, fulfilled: 0, review: 0 })
    expect(alert).not.toHaveBeenCalled()
    expect(errorLog).toHaveBeenCalled()
  })

  it("two overlapping sweeps that both listed one row: it is claimed once and its handler runs once", async () => {
    const rows = [payRow({ order_table: "results_check_requests" })]
    const handler = vi.fn(async () => {})
    const { client } = fakeDb(rows)
    const [a, b] = await Promise.all([
      sweep(client, { results_check_requests: handler }),
      sweep(client, { results_check_requests: handler }),
    ])
    expect(a.found + b.found).toBe(2) // both listed it before either claimed it
    expect(handler).toHaveBeenCalledTimes(1)
    expect(a.fulfilled + b.fulfilled).toBe(1)
    expect(rows[0].state).toBe("fulfilled")
  })

  it("a sweep starting while another still runs the handler does not list the claimed row", async () => {
    const rows = [payRow({ order_table: "results_check_requests" })]
    const { client } = fakeDb(rows)
    let inner: Awaited<ReturnType<typeof sweep>> | null = null
    const handler = vi.fn(async () => {
      inner = await sweep(client, { results_check_requests: handler })
    })
    await sweep(client, { results_check_requests: handler })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(inner).toEqual({ found: 0, fulfilled: 0, review: 0 })
  })

  it("a row claimed within the lease is not listed; one whose claim expired is", async () => {
    expect(WALLET_SWEEP_LEASE_MS).toBeGreaterThan(300_000) // above the route's maxDuration
    const rows = [
      payRow({ id: "held", order_id: "O-held", updated_at: new Date(NOW - WALLET_SWEEP_LEASE_MS + 1000).toISOString() }),
      payRow({ id: "expired", order_id: "O-exp", updated_at: new Date(NOW - WALLET_SWEEP_LEASE_MS - 1000).toISOString() }),
    ]
    const handler = vi.fn(async () => {})
    await sweep(fakeDb(rows).client, { ussd_orders: handler })
    expect(handler.mock.calls).toEqual([["O-exp"]])
  })

  it.each([
    ["returned", { updateError: (_: string, p: Row) => (p.state ? null : { code: "XX000", message: `down ${PHONE}` }) }],
    ["thrown", { updateThrows: (_: string, p: Row) => !p.state }],
  ])("a %s claim error skips the row: no handler, no throw, logged", async (_, opts) => {
    const rows = [payRow()]
    const handler = vi.fn(async () => {})
    const res = await sweep(fakeDb(rows, opts).client, { ussd_orders: handler })
    expect(res).toEqual({ found: 1, fulfilled: 0, review: 0 })
    expect(handler).not.toHaveBeenCalled()
    expect(rows[0].state).toBe("debited")
    expect(errorLog).toHaveBeenCalled()
    expect(logged()).not.toContain(PHONE)
  })

  it("the row's amount reaches the alert even when the needs_review write fails", async () => {
    const rows = [payRow({ amount: "9.40" })]
    const alert = vi.fn(async (_m: string) => {})
    const db = fakeDb(rows, { updateError: (_: string, p: Row) => (p.state === "needs_review" ? { code: "XX000", message: "down" } : null) })
    const res = await sweep(db.client, { ussd_orders: vi.fn(async () => { throw new Error("boom") }) }, alert)
    expect(res.review).toBe(1)
    expect(alert.mock.calls[0][0]).toContain("GHS 9.40")
  })

  it("past the deadline it starts no new row; the next run picks it up", async () => {
    const rows = [payRow()]
    const handler = vi.fn(async () => {})
    const res = await sweep(fakeDb(rows).client, { ussd_orders: handler }, undefined, Date.now() - 1)
    expect(handler).not.toHaveBeenCalled()
    expect(rows[0].state).toBe("debited")
    expect(res).toEqual({ found: 1, fulfilled: 0, review: 0 })
  })
})

describe("the money table's write surface", () => {
  it("never inserts into or deletes from hubtel_wallet_payments: only the RPC inserts", () => {
    const src = readFileSync(path.join(process.cwd(), "lib/ussd-hubtel/wallet-pay.ts"), "utf8")
    expect(src).not.toMatch(/\.(insert|upsert|delete)\(/)
  })
})
