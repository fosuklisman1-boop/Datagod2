// lib/ussd-hubtel/order-handlers.bots.test.ts
// Commission Cashback bot orders (hubtel_bill_orders / hubtel_data_orders) paid through the Hubtel USSD checkout:
// the payment handler (through the REAL shared confirmation, confirmBotOrder, on fake deps), processFulfillment end
// to end (duplicate callbacks), and the expiry / "not paid" fail handlers.
import { describe, it, expect, vi } from "vitest"
import {
  BOT_NEEDS_REVIEW_PREFIX, createFailHandlers, createOrderHandlers, createPaidReviewHandlers, failOrderStrict, recordBotPaymentForReview,
  type ConfirmBotFn,
} from "./order-handlers"
import { processFulfillment } from "./payment"
import { runStatusChecks } from "./status-check"
import { loadRefundableOrders } from "@/lib/refunds/orders"
import { orderEligibility } from "@/lib/refunds/eligibility"
import { moolreGateway } from "@/lib/refunds/gateways/moolre"
import { paystackGateway } from "@/lib/refunds/gateways/paystack"
import { BOT_UNPAID_FAILURE_REASON } from "./order-tables"
import { confirmBotOrder, type ConfirmDeps } from "@/lib/storefront-commission/confirm"
import type { StorefrontOrderTable } from "@/lib/storefront-commission/payment"
import type { HubtelFulfillmentInfo, HubtelTxRow, HubtelTxStore } from "./types"

// The refund gateways are only asked what they support; no network module may load for real.
vi.mock("@/lib/paystack", () => ({ refundTransaction: vi.fn(), fetchRefund: vi.fn() }))
vi.mock("@/lib/moolre-transfer", () => ({ initiateTransfer: vi.fn(), getTransferStatus: vi.fn() }))

type Row = Record<string, any>
const NOW = Date.parse("2026-10-14T12:00:00Z")

function botBundle(o: Row = {}): Row {
  return {
    id: "d1", reference_code: "SB-BOT", channel: "bots", bot_surface: "hubtel_ussd", shop_id: "shop1", user_id: null,
    amount: 10, paid_amount: 10.03, shop_share_amount: 0.15, buyer_phone: "233241234567",
    status: "pending", payment_status: "unpaid", payment_reference: null, hubtel_client_reference: null, notes: null,
    failure_reason: null, created_at: new Date(NOW - 60_000).toISOString(), ...o,
  }
}
function botBill(o: Row = {}): Row {
  return {
    id: "b1", reference_code: "BILL-BOT", channel: "bots", bot_surface: "hubtel_ussd", shop_id: null, user_id: null, biller: "ecg",
    amount: 20, paid_amount: 20.2, shop_share_amount: 0, buyer_phone: "233241234567",
    status: "pending", payment_status: "unpaid", payment_reference: null, hubtel_client_reference: null, notes: null,
    failure_reason: null, verified_at: new Date(NOW - 60_000).toISOString(), created_at: new Date(NOW - 60_000).toISOString(), ...o,
  }
}
function txRow(o: Partial<HubtelTxRow> = {}): HubtelTxRow {
  return {
    session_id: "S1", hubtel_order_id: null, platform: "USSD", order_table: "hubtel_data_orders", order_id: "d1",
    mobile: "233241234567", expected_amount: 10.03, amount_paid: null, amount_after_charges: null, state: "awaiting_payment",
    callback_status: "not_due", callback_attempts: 0, callback_last_error: null, callback_sent_at: null, review_reason: null,
    status_check_attempts: 0, last_status_check_at: null, paid_at: null, created_at: "", updated_at: "", ...o,
  } as HubtelTxRow
}

/**
 * Filter-aware PostgREST fake over in-memory tables. Supports select/eq/in/not(col,'is',null)/order/limit with
 * maybeSingle() or an awaited query, and update(...).eq/in(...).select() (applies to every matching row).
 */
function fakeDb(tables: Record<string, Row[]>) {
  const updates: Array<{ table: string; patch: Row; matched: number }> = []
  const client: any = {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []
      let patch: Row | null = null
      let orderBy: { col: string; asc: boolean } | null = null
      let lim: number | null = null
      const rows = () => {
        let out = (tables[table] ?? []).filter(r => filters.every(f => f(r)))
        if (orderBy) {
          const { col, asc } = orderBy
          out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
        }
        return lim == null ? out : out.slice(0, lim)
      }
      const runUpdate = () => {
        const hit = rows()
        for (const r of hit) Object.assign(r, patch)
        updates.push({ table, patch: patch!, matched: hit.length })
        return { data: hit.map(r => ({ id: r.id })), error: null }
      }
      const q: any = {
        select: () => (patch ? Promise.resolve(runUpdate()) : q),
        update: (p: Row) => { patch = p; return q },
        eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return q },
        in: (c: string, vs: unknown[]) => { filters.push(r => vs.includes(r[c])); return q },
        not: (c: string, op: string, v: unknown) => {
          if (op !== "is" || v !== null) throw new Error("fake: unsupported not()")
          filters.push(r => r[c] != null); return q
        },
        order: (c: string, o?: { ascending?: boolean }) => { orderBy = { col: c, asc: o?.ascending !== false }; return q },
        limit: (n: number) => { lim = n; return q },
        maybeSingle: async () => {
          const r = rows()[0]
          return { data: r ? { ...r } : null, error: null }
        },
        then: (res: any, rej: any) => Promise.resolve(patch ? runUpdate() : { data: rows().map(r => ({ ...r })), error: null }).then(res, rej),
      }
      return q
    },
  }
  return { client, updates }
}

/** ConfirmDeps over the same tables: guarded flip, unique shop share per order, dispatch = one Hubtel POST claim. */
function engine(tables: Record<string, Row[]>) {
  const profits: Row[] = []
  const alerts: string[] = []
  let flips = 0
  let posts = 0
  const find = (t: StorefrontOrderTable, id: string) => (tables[t] ?? []).find(r => r.id === id) ?? null
  const d: ConfirmDeps = {
    async getOrder(t, id) { const r = find(t, id); return r ? ({ ...r } as any) : null },
    async markPaid(t, id, p) {
      const r = find(t, id)
      if (!r || !["storefront", "bots"].includes(r.channel) || r.payment_status !== "unpaid") return 0
      Object.assign(r, { payment_status: "paid", ...p })
      flips++
      return 1
    },
    async insertShopProfit(row) {
      const key = row.data_order_id ?? row.bill_order_id
      if (profits.some(p => (p.data_order_id ?? p.bill_order_id) === key)) throw Object.assign(new Error("dup"), { code: "23505" })
      profits.push(row)
    },
    billsAutoFulfil: async () => true,
    async dispatch(t, id) {
      const r = find(t, id)
      if (!r || r.status !== "pending") return r?.status ?? "missing"
      Object.assign(r, { status: "processing", notes: "Dispatching", hubtel_client_reference: "HCS-1" })
      posts++
      return "processing"
    },
    async setPendingNote() { return 0 },
    async hasLedgerRow() { return false },
    async alert(m) { alerts.push(m) },
    now: () => NOW,
  }
  const confirmBot: ConfirmBotFn = vi.fn((t, id, p) => confirmBotOrder(d, t, id, p))
  return { confirmBot, profits, alerts, counts: () => ({ flips, posts }) }
}

/** HubtelTxStore over tables.hubtel_transactions, so the handler reads what processFulfillment wrote. */
function txStore(tables: Record<string, Row[]>): HubtelTxStore {
  const get = (sid: string) => (tables.hubtel_transactions ?? []).find(r => r.session_id === sid) as HubtelTxRow | undefined
  return {
    findBySession: async sid => { const r = get(sid); return r ? { ...r } : null },
    claim: async (sid, from = ["awaiting_payment"]) => {
      const r = get(sid)
      if (r && from.includes(r.state)) { r.state = "processing"; return true }
      return false
    },
    updateIf: async () => false,
    update: async (sid, patch) => { const r = get(sid); if (r) Object.assign(r, patch) },
    listPendingCallbacks: async () => [],
    listAwaitingPayment: async () => (tables.hubtel_transactions ?? []).filter(r => r.state === "awaiting_payment").map(r => ({ ...r }) as HubtelTxRow),
    listStaleProcessing: async () => [],
    listIndeterminate: async () => (tables.hubtel_transactions ?? [])
      .filter(r => r.state === "needs_review" && r.callback_status === "not_due" && r.paid_at == null).map(r => ({ ...r }) as HubtelTxRow),
  }
}

const paidInfo = (o: Partial<HubtelFulfillmentInfo> = {}): HubtelFulfillmentInfo =>
  ({ sessionId: "S1", hubtelOrderId: "H1", amountPaid: 10.3, amountAfterCharges: 10.03, isSuccessful: true, ...o })

/** A paid bot order held for a human: paid (with this payment's reference), failed, "needs review: …", never sent. */
function expectHeldForReview(row: Row, reference: string, reason: RegExp) {
  expect(row).toMatchObject({ payment_status: "paid", payment_reference: reference, status: "failed", hubtel_client_reference: null })
  expect(row.paid_at).toBeTruthy()
  expect(String(row.failure_reason)).toMatch(new RegExp(`^${BOT_NEEDS_REVIEW_PREFIX}`))
  expect(String(row.failure_reason)).toMatch(reason)
}

describe("bot commission payment handler (Hubtel USSD)", () => {
  it("shop mode: one Hubtel payment => confirmed once, one shop share, one POST; reference = Hubtel OrderId", async () => {
    const tables = { hubtel_data_orders: [botBundle()], hubtel_transactions: [txRow()] }
    const { client } = fakeDb(tables)
    const e = engine(tables)
    const store = txStore(tables)
    const handlers = createOrderHandlers(client, { confirmBot: e.confirmBot })

    expect(await processFulfillment(store, handlers, paidInfo())).toBe("fulfilled")
    expect(e.confirmBot).toHaveBeenCalledTimes(1)
    expect(e.confirmBot).toHaveBeenCalledWith("hubtel_data_orders", "d1", { paidAmount: 10.03, reference: "H1" })
    expect(tables.hubtel_data_orders[0]).toMatchObject({ payment_status: "paid", payment_reference: "H1", status: "processing" })
    expect(e.profits).toEqual([expect.objectContaining({ shop_id: "shop1", data_order_id: "d1", profit_amount: 0.15 })])
    expect(e.counts()).toEqual({ flips: 1, posts: 1 })
    expect(tables.hubtel_transactions[0]).toMatchObject({ state: "fulfilled", callback_status: "pending" })

    // Duplicate callback for the same session: processFulfillment refuses it before the handler.
    expect(await processFulfillment(store, handlers, paidInfo())).toBe("duplicate")
    expect(e.confirmBot).toHaveBeenCalledTimes(1)
    expect(e.profits).toHaveLength(1)
    expect(e.counts()).toEqual({ flips: 1, posts: 1 })
  })

  it("a replayed handler run (same payment) is already_processed: no second flip, share or POST, and no needs_review", async () => {
    const tables = { hubtel_data_orders: [botBundle()], hubtel_transactions: [txRow({ hubtel_order_id: "H1", paid_at: "2026-10-14T12:00:00Z", amount_after_charges: 10.03 })] }
    const { client } = fakeDb(tables)
    const e = engine(tables)
    const h = createOrderHandlers(client, { confirmBot: e.confirmBot }).hubtel_data_orders
    await h("d1")
    await expect(h("d1")).resolves.toBeUndefined()
    expect(await (e.confirmBot as any).mock.results[1].value).toEqual({ outcome: "already_processed", status: "processing" })
    expect(e.profits).toHaveLength(1)
    expect(e.counts()).toEqual({ flips: 1, posts: 1 })
    expect(e.alerts).toEqual([])
  })

  it("main mode (no shop): confirmed with no shop share", async () => {
    const tables = {
      hubtel_data_orders: [botBundle({ shop_id: null, shop_share_amount: 0 })],
      hubtel_transactions: [txRow()],
    }
    const { client } = fakeDb(tables)
    const e = engine(tables)
    expect(await processFulfillment(txStore(tables), createOrderHandlers(client, { confirmBot: e.confirmBot }), paidInfo())).toBe("fulfilled")
    expect(e.profits).toEqual([])
    expect(e.counts()).toEqual({ flips: 1, posts: 1 })
  })

  it("bill order: confirmed through the same engine with paidAmount = Hubtel's amount after charges", async () => {
    const tables = {
      hubtel_bill_orders: [botBill()],
      hubtel_transactions: [txRow({ order_table: "hubtel_bill_orders", order_id: "b1", expected_amount: 20.2 })],
    }
    const { client } = fakeDb(tables)
    const e = engine(tables)
    const out = await processFulfillment(txStore(tables), createOrderHandlers(client, { confirmBot: e.confirmBot }),
      paidInfo({ hubtelOrderId: "HB9", amountPaid: 20.6, amountAfterCharges: 20.2 }))
    expect(out).toBe("fulfilled")
    expect(e.confirmBot).toHaveBeenCalledWith("hubtel_bill_orders", "b1", { paidAmount: 20.2, reference: "HB9" })
    expect(tables.hubtel_bill_orders[0]).toMatchObject({ payment_status: "paid", status: "processing" })
    expect(e.profits).toEqual([])
  })

  it("underpaid Hubtel amount never reaches the engine; the payment is recorded on the order for review", async () => {
    const tables = { hubtel_data_orders: [botBundle()], hubtel_transactions: [txRow()] }
    const { client } = fakeDb(tables)
    const e = engine(tables)
    const out = await processFulfillment(txStore(tables), createOrderHandlers(client, { confirmBot: e.confirmBot }), paidInfo({ amountAfterCharges: 9.5 }),
      { paidReview: createPaidReviewHandlers(client) })
    expect(out).toBe("needs_review")
    expect(e.confirmBot).not.toHaveBeenCalled()
    expectHeldForReview(tables.hubtel_data_orders[0], "H1", /short/)
    expect(e.profits).toEqual([])
    expect(e.counts()).toEqual({ flips: 0, posts: 0 })
  })

  it("F2: the engine checks Hubtel's own amount: an over-payment (decidePayment accepts it) => amount_mismatch, recorded for review", async () => {
    const tables = { hubtel_data_orders: [botBundle()], hubtel_transactions: [txRow()] }
    const { client } = fakeDb(tables)
    const e = engine(tables)
    const out = await processFulfillment(txStore(tables), createOrderHandlers(client, { confirmBot: e.confirmBot }), paidInfo({ amountAfterCharges: 10.04 }))
    expect(out).toBe("needs_review")
    expect(e.confirmBot).toHaveBeenCalledWith("hubtel_data_orders", "d1", { paidAmount: 10.04, reference: "H1" })
    expect(tables.hubtel_transactions[0].review_reason).toMatch(/amount_mismatch/)
    expectHeldForReview(tables.hubtel_data_orders[0], "H1", /amount_mismatch/)
    expect(e.profits).toEqual([])
    expect(e.counts()).toEqual({ flips: 0, posts: 0 })
  })

  it("F2: one pesewa short passes decidePayment but not the engine's pesewa-exact check => recorded for review", async () => {
    const tables = { hubtel_data_orders: [botBundle()], hubtel_transactions: [txRow()] }
    const { client } = fakeDb(tables)
    const e = engine(tables)
    const out = await processFulfillment(txStore(tables), createOrderHandlers(client, { confirmBot: e.confirmBot }), paidInfo({ amountAfterCharges: 10.02 }))
    expect(out).toBe("needs_review")
    expect(e.confirmBot).toHaveBeenCalledWith("hubtel_data_orders", "d1", { paidAmount: 10.02, reference: "H1" })
    expectHeldForReview(tables.hubtel_data_orders[0], "H1", /amount_mismatch/)
    expect(e.counts()).toEqual({ flips: 0, posts: 0 })
  })

  for (const outcome of ["refused", "error", "amount_mismatch"] as const) {
    it(`outcome '${outcome}' records the payment on the order (paid + failed, needs review) and throws (=> needs_review)`, async () => {
      const tables = { hubtel_data_orders: [botBundle()], hubtel_transactions: [txRow({ hubtel_order_id: "H1", paid_at: "x", amount_after_charges: 10.03 })] }
      const { client } = fakeDb(tables)
      const h = createOrderHandlers(client, { confirmBot: async () => ({ outcome }) }).hubtel_data_orders
      await expect(h("d1")).rejects.toThrow(new RegExp(`'${outcome}'`))
      expectHeldForReview(tables.hubtel_data_orders[0], "H1", new RegExp(`'${outcome}'`))
    })
  }

  it("ordering: the engine already flipped the order paid, then reported 'error' => the review record is a no-op (no double credit)", async () => {
    const tables = { hubtel_data_orders: [botBundle()], hubtel_transactions: [txRow({ hubtel_order_id: "H1", paid_at: "x", amount_after_charges: 10.03 })] }
    const { client, updates } = fakeDb(tables)
    const e = engine(tables)
    // The flip (and share + POST) committed, but the caller saw an error (e.g. a timeout after the write).
    const confirmBot: ConfirmBotFn = async (t, id, p) => { await e.confirmBot(t, id, p); return { outcome: "error" } }
    await expect(createOrderHandlers(client, { confirmBot }).hubtel_data_orders("d1")).rejects.toThrow(/'error'/)
    expect(tables.hubtel_data_orders[0]).toMatchObject({ payment_status: "paid", payment_reference: "H1", status: "processing", failure_reason: null })
    expect(updates.filter(u => u.table === "hubtel_data_orders").map(u => u.matched)).toEqual([0])
    expect(e.profits).toHaveLength(1)
    expect(e.counts()).toEqual({ flips: 1, posts: 1 })
  })

  it("orphan race (finding 3/4): a payment for an unpaid order that was already failed is recorded for review; the engine is not called", async () => {
    const tables = {
      hubtel_data_orders: [botBundle({ status: "failed", failure_reason: BOT_UNPAID_FAILURE_REASON })],
      hubtel_transactions: [txRow()],
    }
    const { client } = fakeDb(tables)
    const e = engine(tables)
    expect(await processFulfillment(txStore(tables), createOrderHandlers(client, { confirmBot: e.confirmBot }), paidInfo())).toBe("needs_review")
    expect(e.confirmBot).not.toHaveBeenCalled()
    expectHeldForReview(tables.hubtel_data_orders[0], "H1", /after the order was failed/)
    expect(e.profits).toEqual([])
    expect(e.counts()).toEqual({ flips: 0, posts: 0 })
  })

  it("refuses a non-bot row without calling the engine", async () => {
    const tables = { hubtel_data_orders: [botBundle({ channel: "storefront" })], hubtel_transactions: [txRow({ hubtel_order_id: "H1", paid_at: "x" })] }
    const { client } = fakeDb(tables)
    const confirmBot = vi.fn()
    await expect(createOrderHandlers(client, { confirmBot }).hubtel_data_orders("d1")).rejects.toThrow(/not a bot order/)
    expect(confirmBot).not.toHaveBeenCalled()
  })

  it("throws on a missing order; a missing paid_amount is recorded for review and throws", async () => {
    const tables = { hubtel_data_orders: [botBundle({ paid_amount: null })], hubtel_transactions: [txRow({ hubtel_order_id: "H1", paid_at: "x", amount_after_charges: 10.03 })] }
    const { client } = fakeDb(tables)
    const confirmBot = vi.fn()
    const h = createOrderHandlers(client, { confirmBot }).hubtel_data_orders
    await expect(h("d1")).rejects.toThrow(/paid_amount/)
    expectHeldForReview(tables.hubtel_data_orders[0], "H1", /paid_amount/)
    await expect(h("nope")).rejects.toThrow(/not found/)
    expect(confirmBot).not.toHaveBeenCalled()
  })

  it("no Hubtel amount on the paid tx row => recorded for review, the engine is not called", async () => {
    const tables = { hubtel_data_orders: [botBundle()], hubtel_transactions: [txRow({ hubtel_order_id: "H1", paid_at: "x", amount_after_charges: null })] }
    const { client } = fakeDb(tables)
    const confirmBot = vi.fn()
    await expect(createOrderHandlers(client, { confirmBot }).hubtel_data_orders("d1")).rejects.toThrow(/no Hubtel amount/)
    expect(confirmBot).not.toHaveBeenCalled()
    expectHeldForReview(tables.hubtel_data_orders[0], "H1", /no Hubtel amount/)
  })

  it("status-check payment without a Hubtel OrderId: reference falls back to the session id (stable on retry)", async () => {
    const tables = { hubtel_data_orders: [botBundle()], hubtel_transactions: [txRow()] }
    const { client } = fakeDb(tables)
    const e = engine(tables)
    expect(await processFulfillment(txStore(tables), createOrderHandlers(client, { confirmBot: e.confirmBot }), paidInfo({ hubtelOrderId: null }))).toBe("fulfilled")
    expect(e.confirmBot).toHaveBeenCalledWith("hubtel_data_orders", "d1", { paidAmount: 10.03, reference: "hubtel-session:S1" })
  })

  it("picks the most recently paid tx row when the order has several", async () => {
    const tables = {
      hubtel_data_orders: [botBundle()],
      hubtel_transactions: [
        txRow({ session_id: "S0", hubtel_order_id: null, paid_at: null }),
        txRow({ session_id: "S1", hubtel_order_id: "H-old", paid_at: "2026-10-14T11:00:00Z", amount_after_charges: 9 }),
        txRow({ session_id: "S2", hubtel_order_id: "H-new", paid_at: "2026-10-14T11:30:00Z", amount_after_charges: 10.03 }),
      ],
    }
    const { client } = fakeDb(tables)
    const confirmBot = vi.fn(async () => ({ outcome: "confirmed" as const }))
    await createOrderHandlers(client, { confirmBot }).hubtel_data_orders("d1")
    expect(confirmBot).toHaveBeenCalledWith("hubtel_data_orders", "d1", { paidAmount: 10.03, reference: "H-new" })
  })

  it("no paid tx row => throws", async () => {
    const tables = { hubtel_data_orders: [botBundle()], hubtel_transactions: [txRow()] }
    const { client } = fakeDb(tables)
    await expect(createOrderHandlers(client, { confirmBot: vi.fn() }).hubtel_data_orders("d1")).rejects.toThrow(/no paid hubtel_transactions/)
  })
})

describe("bot commission fail handlers (expiry / not paid)", () => {
  for (const table of ["hubtel_bill_orders", "hubtel_data_orders"] as const) {
    const mk = table === "hubtel_bill_orders" ? botBill : botBundle
    it(`${table}: an unpaid pending bot order is failed with the fail patch; payment_status stays unpaid`, async () => {
      const tables: Record<string, Row[]> = { [table]: [mk({ id: "o1" })] }
      const { client } = fakeDb(tables)
      await createFailHandlers(client)[table]("o1")
      expect(tables[table][0]).toMatchObject({ status: "failed", failure_reason: BOT_UNPAID_FAILURE_REASON, payment_status: "unpaid" })
      expect(tables[table][0].updated_at).toBeTruthy()
    })
    it(`${table}: a paid order is never touched`, async () => {
      const tables: Record<string, Row[]> = { [table]: [mk({ id: "o1", payment_status: "paid", status: "processing" })] }
      const { client, updates } = fakeDb(tables)
      await createFailHandlers(client)[table]("o1")
      expect(tables[table][0]).toMatchObject({ payment_status: "paid", status: "processing", failure_reason: null })
      expect(updates[0].matched).toBe(0)
      await expect(failOrderStrict(client, table, "o1")).rejects.toThrow(/not in an unpaid state/)
    })
    it(`${table}: a non-bot unpaid row is never touched`, async () => {
      const tables: Record<string, Row[]> = { [table]: [mk({ id: "o1", channel: "storefront" })] }
      const { client } = fakeDb(tables)
      await createFailHandlers(client)[table]("o1")
      expect(tables[table][0].status).toBe("pending")
    })
    it(`${table}: strict fail succeeds once, then refuses (already failed)`, async () => {
      const tables: Record<string, Row[]> = { [table]: [mk({ id: "o1" })] }
      const { client } = fakeDb(tables)
      await failOrderStrict(client, table, "o1")
      expect(tables[table][0].status).toBe("failed")
      await expect(failOrderStrict(client, table, "o1")).rejects.toThrow(/not in an unpaid state/)
    })
  }
})

/** Refund loader fake: every query on a table returns that table's rows (filters ignored), as lib/refunds/bots.test.ts. */
function refundsDb(rows: Record<string, unknown[]>) {
  const make = (table: string) => {
    const q: any = {}
    for (const m of ["select", "eq", "in", "is", "neq", "not", "gte", "order", "range", "limit", "or"]) q[m] = () => q
    q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(res, rej)
    return q
  }
  return { from: (t: string) => make(t) } as any
}

/** The order as /admin/refunds loads and judges it (Hubtel rail: no wallet_payments row, no ledger row). */
async function refundView(table: StorefrontOrderTable, row: Row) {
  const db = refundsDb({ [table]: [{ ...row, updated_at: new Date(NOW - 10 * 60_000).toISOString() }] })
  const [o] = await loadRefundableOrders(db, [{ table, id: row.id }])
  return o
}

describe("F1: a paid bot order held for review is recorded paid, never sent, and refundable", () => {
  it("recordBotPaymentForReview: guarded unpaid -> paid + failed; a second call (or an already-paid row) is a no-op", async () => {
    for (const table of ["hubtel_bill_orders", "hubtel_data_orders"] as const) {
      const mk = table === "hubtel_bill_orders" ? botBill : botBundle
      const tables: Record<string, Row[]> = { [table]: [mk({ id: "o1" })] }
      const { client } = fakeDb(tables)
      expect(await recordBotPaymentForReview(client, table, "o1", { reference: "H1", reason: "x" })).toBe(1)
      expectHeldForReview(tables[table][0], "H1", /x\. Not sent/)
      expect(await recordBotPaymentForReview(client, table, "o1", { reference: "H2", reason: "y" })).toBe(0)
      expect(tables[table][0].payment_reference).toBe("H1")
      // a storefront row is never touched by the bot recorder
      const sf: Record<string, Row[]> = { [table]: [mk({ id: "o1", channel: "storefront" })] }
      expect(await recordBotPaymentForReview(fakeDb(sf).client, table, "o1", { reference: "H1", reason: "x" })).toBe(0)
      expect(sf[table][0].payment_status).toBe("unpaid")
    }
  })

  for (const table of ["hubtel_bill_orders", "hubtel_data_orders"] as const) {
    it(`${table}: expiry (definite not paid) fails the order, then a late success is recorded paid, NOT dispatched, and refundable via Moolre / manual to buyer_phone`, async () => {
      const mk = table === "hubtel_bill_orders" ? botBill : botBundle
      const id = table === "hubtel_bill_orders" ? "b1" : "d1"
      const expected = table === "hubtel_bill_orders" ? 20.2 : 10.03
      const tables: Record<string, Row[]> = {
        [table]: [mk()],
        hubtel_transactions: [txRow({
          order_table: table, order_id: id, expected_amount: expected, created_at: new Date(NOW - 2 * 60 * 60_000).toISOString(),
        })],
      }
      const { client } = fakeDb(tables)
      const e = engine(tables)
      const store = txStore(tables)
      const handlers = createOrderHandlers(client, { confirmBot: e.confirmBot })
      const paidReviewHandlers = createPaidReviewHandlers(client)

      // 1. The status-check cron expires the row: Hubtel says Unpaid, so the bot order is failed (still unpaid).
      const run1 = await runStatusChecks({
        store, handlers, failHandlers: createFailHandlers(client), paidReviewHandlers, now: NOW,
        check: async () => ({ ok: true, status: "Unpaid" }),
      })
      expect(run1.expired).toBe(1)
      expect(tables.hubtel_transactions[0].state).toBe("failed")
      expect(tables[table][0]).toMatchObject({ status: "failed", payment_status: "unpaid", failure_reason: BOT_UNPAID_FAILURE_REASON })

      // 2. Hubtel's success callback arrives late: needs_review, the handler / engine are NOT run, the payment is
      //    recorded on the order.
      const out = await processFulfillment(store, handlers, paidInfo({ hubtelOrderId: "HLATE", amountAfterCharges: expected }), { paidReview: paidReviewHandlers })
      expect(out).toBe("needs_review")
      expect(tables.hubtel_transactions[0]).toMatchObject({ state: "needs_review", callback_status: "pending", hubtel_order_id: "HLATE" })
      expect(tables.hubtel_transactions[0].review_reason).toMatch(/late success after expiry/)
      expect(e.confirmBot).not.toHaveBeenCalled()
      expectHeldForReview(tables[table][0], "HLATE", /arrived late/)
      expect(e.profits).toEqual([])
      expect(e.counts()).toEqual({ flips: 0, posts: 0 })

      // A duplicate of the late callback changes nothing.
      expect(await processFulfillment(store, handlers, paidInfo({ hubtelOrderId: "HLATE" }), { paidReview: paidReviewHandlers })).toBe("duplicate")
      expect(tables[table][0].payment_reference).toBe("HLATE")

      // 3. /admin/refunds: listed shape (bots, failed, paid), eligible, Moolre payout (or manual) to buyer_phone only.
      const o = await refundView(table, tables[table][0])
      expect(o.orderStatus).toBe("failed")
      expect(o.paymentStatus).toBe("completed")
      expect(o.evidence.commission?.storefront).toBe(true)
      expect(o.payment).toEqual({ gateway: null, reference: null, payerPhone: "0241234567", walletUserId: null })
      expect(o.paid).toBe(expected)
      expect(o.owners).toEqual([])
      expect(orderEligibility(o, NOW)).toEqual({ eligible: true })
      expect(moolreGateway.supports(o)).toEqual({ ok: true })
      expect(paystackGateway.supports(o).ok).toBe(false)
    })
  }

  it("indeterminate expiry, then the re-check finds it Paid => recorded paid + failed (needs review), not dispatched", async () => {
    const tables: Record<string, Row[]> = {
      hubtel_data_orders: [botBundle()],
      hubtel_transactions: [txRow({ created_at: new Date(NOW - 2 * 60 * 60_000).toISOString() })],
    }
    const { client } = fakeDb(tables)
    const e = engine(tables)
    const store = txStore(tables)
    const args = {
      store, handlers: createOrderHandlers(client, { confirmBot: e.confirmBot }), failHandlers: createFailHandlers(client),
      paidReviewHandlers: createPaidReviewHandlers(client), now: NOW,
    }
    // Relay down at expiry: parked, the order is NOT failed.
    expect((await runStatusChecks({ ...args, check: async () => ({ ok: false, error: "relay down" }) })).held).toBe(1)
    expect(tables.hubtel_data_orders[0]).toMatchObject({ status: "pending", payment_status: "unpaid" })
    // Next run: Hubtel says Paid.
    const run2 = await runStatusChecks({
      ...args, now: NOW + 10 * 60_000,
      check: async () => ({ ok: true, status: "Paid", data: { transactionId: "TX9", amount: 10.3, amountAfterCharges: 10.03 } }),
    })
    expect(run2.recovered).toBe(1)
    expect(e.confirmBot).not.toHaveBeenCalled()
    expectHeldForReview(tables.hubtel_data_orders[0], "TX9", /indeterminate park/)
    expect(e.counts()).toEqual({ flips: 0, posts: 0 })
    expect(e.profits).toEqual([])
  })

  it("without paid-review handlers (legacy callers) the late path leaves the order alone", async () => {
    const tables: Record<string, Row[]> = {
      hubtel_data_orders: [botBundle({ status: "failed", failure_reason: BOT_UNPAID_FAILURE_REASON })],
      hubtel_transactions: [txRow({ state: "failed" })],
    }
    const { client } = fakeDb(tables)
    expect(await processFulfillment(txStore(tables), createOrderHandlers(client, { confirmBot: vi.fn() }), paidInfo())).toBe("needs_review")
    expect(tables.hubtel_data_orders[0]).toMatchObject({ status: "failed", payment_status: "unpaid" })
  })

  it("a throwing recorder never changes processFulfillment's outcome", async () => {
    const tables: Record<string, Row[]> = { hubtel_data_orders: [botBundle()], hubtel_transactions: [txRow({ state: "failed" })] }
    const { client } = fakeDb(tables)
    const paidReview = { hubtel_data_orders: async () => { throw new Error("db down") } }
    expect(await processFulfillment(txStore(tables), createOrderHandlers(client, { confirmBot: vi.fn() }), paidInfo(), { paidReview })).toBe("needs_review")
  })
})
