// lib/ussd-hubtel/order-handlers.shop.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const fulfillUssdOrder = vi.fn()
const sendSMS = vi.fn()
const trackCustomer = vi.fn()
const markAirtimeOrderPaid = vi.fn()
const fulfillPaidResultsCheckerOrder = vi.fn()
vi.mock("@/lib/ussd/fulfill", () => ({ fulfillUssdOrder: (...a: any[]) => fulfillUssdOrder(...a) }))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: (...a: any[]) => sendSMS(...a),
  SMSTemplates: {
    ussdOrderConfirmed: (size: string, network: string, link?: string) => `confirmed ${size} ${network} ${link ?? "no-link"}`,
    ussdPaymentConfirmed: () => "paid",
    ussdAirtimePaymentReceived: () => "airtime-paid",
    ussdAfaPaymentReceived: () => "afa-paid",
  },
}))
vi.mock("@/lib/app-settings", () => ({ getJoinCommunityLink: async () => "link" }))
vi.mock("@/lib/customer-tracking-service", () => ({ customerTrackingService: { trackCustomer: (...a: any[]) => trackCustomer(...a) } }))
vi.mock("@/lib/airtime-service", () => ({ markAirtimeOrderPaid: (...a: any[]) => markAirtimeOrderPaid(...a) }))
vi.mock("@/lib/results-checker-service", () => ({
  fulfillPaidResultsCheckerOrder: (...a: any[]) => fulfillPaidResultsCheckerOrder(...a),
  fulfillPaidResultsCheckRequest: vi.fn(),
}))
vi.mock("@/lib/ussd/fulfill-afa", () => ({ fulfillUssdAfaOrder: vi.fn() }))

import { createOrderHandlers, createFailHandlers } from "./order-handlers"
import { processFulfillment } from "./payment"
import type { HubtelTxRow, HubtelTxStore } from "./types"

interface FakeOpts {
  /** shop_profits insert fails with a real (non-unique) error. */
  profitError?: boolean
  /** The conditional mark matches 0 rows even though the read saw a payable row (a concurrent winner). */
  markLoses?: boolean
  /** Reads of ussd_shop_orders after the first one fail (the post-fulfilment re-read). */
  rereadError?: boolean
  /** shop_profits rows that already exist (exercise the unique-violation backstop). */
  existingProfits?: Array<{ shop_id: string; ussd_shop_order_id: string; profit_amount: number }>
}

/**
 * Table-aware fake. Reads return a COPY of rows[table] (a concurrent reader keeps its stale view,
 * like a real DB read). Every update().eq().in(col, vals) applies only when rows[table][col] is in
 * vals (like the real conditional update), synchronously at call time for the .select() form (so two
 * racing handlers get exactly one winner). shop_profits enforces a UNIQUE (ussd_shop_order_id,
 * shop_id) backstop and answers 23505 on a duplicate, so a double credit is impossible to hide.
 */
function fakeDb(rows: Record<string, any>, opts: FakeOpts = {}) {
  const updates: Array<{ table: string; patch: any; inCol?: string; inVals?: string[] }> = []
  const profits: any[] = [...(opts.existingProfits ?? [])]
  const reads: Record<string, number> = {}
  const client: any = {
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              reads[table] = (reads[table] ?? 0) + 1
              if (opts.rereadError && table === "ussd_shop_orders" && reads[table] > 1) {
                return { data: null, error: { message: "statement timeout" } }
              }
              return { data: rows[table] ? { ...rows[table] } : null, error: null }
            },
          }),
        }),
        update: (patch: any) => {
          const rec: { table: string; patch: any; inCol?: string; inVals?: string[] } = { table, patch }
          const matches = () => {
            const row = rows[table]
            return !!row && (!rec.inCol || (rec.inVals ?? []).includes(row[rec.inCol]))
          }
          const apply = () => { Object.assign(rows[table], patch); updates.push(rec) }
          const chain: any = {
            eq: () => chain,
            in: (col: string, vals: string[]) => { rec.inCol = col; rec.inVals = vals; return chain },
            select: async () => {
              const ok = !opts.markLoses && matches()
              if (ok) apply()
              return { data: ok ? [{ id: rows[table].id }] : [], error: null }
            },
            then: (res: any, rej: any) => {
              try { if (matches()) apply(); return Promise.resolve({ error: null }).then(res, rej) } catch (e) { return rej(e) }
            },
          }
          return chain
        },
        insert: async (list: any[]) => {
          if (table === "shop_profits") {
            if (opts.profitError) return { error: { code: "XX000", message: "profit insert failed" } }
            for (const p of list) {
              if (profits.some(q => q.ussd_shop_order_id === p.ussd_shop_order_id && q.shop_id === p.shop_id)) {
                return { error: { code: "23505", message: "duplicate key value violates unique constraint" } }
              }
            }
            profits.push(...list)
          }
          return { error: null }
        },
      }
    },
  }
  return { client, updates, profits, rows }
}

const shopOrder = (over: Record<string, unknown> = {}) => ({
  id: "o1", shop_id: "shop-1", shop_code_id: "code-1", dialing_phone: "+233200585542", recipient_phone: "0244123456",
  network: "MTN", package_size: "5", amount: 12, shop_price: 12, profit_amount: 2,
  parent_shop_id: null, parent_profit_amount: 0, channel: "ussd_shop",
  order_status: "pending", payment_status: "pending", ...over,
})

const quiet = () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {})
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const log = vi.spyOn(console, "log").mockImplementation(() => {})
  return () => { err.mockRestore(); warn.mockRestore(); log.mockRestore() }
}

const PHONE_DIGITS = ["0244123456", "244123456", "200585542"]
/** Every console line the handler wrote must be free of the customer's phone numbers. */
function expectNoPhonesLogged(spies: Array<ReturnType<typeof vi.spyOn>>) {
  const text = spies.flatMap(s => s.mock.calls).map(c => JSON.stringify(c)).join("\n")
  for (const p of PHONE_DIGITS) expect(text).not.toContain(p)
}

beforeEach(() => {
  for (const m of [fulfillUssdOrder, sendSMS, trackCustomer, markAirtimeOrderPaid, fulfillPaidResultsCheckerOrder]) m.mockReset()
  fulfillUssdOrder.mockResolvedValue({ success: true, message: "ok" })
  markAirtimeOrderPaid.mockResolvedValue({ success: true })
})

describe("ussd_shop_orders post-payment handler", () => {
  it("pending: marks paid (conditional), credits the shop once, tracks, fulfils from ussd_shop_orders, SMSes the recipient only", async () => {
    const { client, updates, profits } = fakeDb({ ussd_shop_orders: shopOrder() })
    await createOrderHandlers(client).ussd_shop_orders("o1")
    expect(updates[0]).toMatchObject({ table: "ussd_shop_orders", patch: { payment_status: "completed" }, inCol: "payment_status", inVals: ["pending", "otp_required"] })
    expect(profits).toEqual([expect.objectContaining({ shop_id: "shop-1", ussd_shop_order_id: "o1", profit_amount: 2, status: "credited" })])
    expect(trackCustomer).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-1", phoneNumber: "0244123456", customerName: "USSD Customer", totalPrice: 12, slug: "ussd_shop", orderId: "o1",
    }))
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(fulfillUssdOrder).toHaveBeenCalledWith("o1", "MTN", "0244123456", "5", false, "ussd_shop_orders")
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(sendSMS.mock.calls[0][0]).toMatchObject({ phone: "0244123456", message: "confirmed 5 MTN no-link", reference: "o1" })
  })
  it("sub-agent order: shop profit AND parent profit, each once, amounts taken from the stored row", async () => {
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder({ profit_amount: 1, parent_shop_id: "parent-1", parent_profit_amount: 1.5 }) })
    await createOrderHandlers(client).ussd_shop_orders("o1")
    expect(profits.map(p => [p.shop_id, p.ussd_shop_order_id, p.profit_amount, p.status])).toEqual([
      ["shop-1", "o1", 1, "credited"], ["parent-1", "o1", 1.5, "credited"],
    ])
  })
  it("zero shop profit: no shop_profits row (as the webhook); parent profit still credited", async () => {
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder({ profit_amount: 0, parent_shop_id: "parent-1", parent_profit_amount: 0.5 }) })
    await createOrderHandlers(client).ussd_shop_orders("o1")
    expect(profits.map(p => p.shop_id)).toEqual(["parent-1"])
  })
  it("zero shop profit and no parent: no shop_profits row at all", async () => {
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder({ profit_amount: 0 }) })
    await createOrderHandlers(client).ussd_shop_orders("o1")
    expect(profits).toEqual([])
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
  })
  it("profit already credited (unique violation 23505): treated as credited, no duplicate row, no throw", async () => {
    const existing = [
      { shop_id: "shop-1", ussd_shop_order_id: "o1", profit_amount: 1 },
      { shop_id: "parent-1", ussd_shop_order_id: "o1", profit_amount: 1.5 },
    ]
    const { client, profits } = fakeDb(
      { ussd_shop_orders: shopOrder({ profit_amount: 1, parent_shop_id: "parent-1", parent_profit_amount: 1.5 }) },
      { existingProfits: existing },
    )
    await createOrderHandlers(client).ussd_shop_orders("o1")
    expect(profits).toEqual(existing)
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })
  it("late payment on an expired (failed) order: throws, no profit, no fulfilment, no SMS (review focus #6)", async () => {
    const { client, profits, updates } = fakeDb({ ussd_shop_orders: shopOrder({ order_status: "failed", payment_status: "failed" }) })
    await expect(createOrderHandlers(client).ussd_shop_orders("o1")).rejects.toThrow(/not in a payable state: failed/)
    expect(updates).toEqual([])
    expect(profits).toEqual([])
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
    expect(trackCustomer).not.toHaveBeenCalled()
  })
  it("lost conditional mark (read saw pending, a concurrent winner flipped it): throws with zero side effects", async () => {
    const { client, profits, updates } = fakeDb({ ussd_shop_orders: shopOrder() }, { markLoses: true })
    await expect(createOrderHandlers(client).ussd_shop_orders("o1")).rejects.toThrow(/not in a payable state/)
    expect(updates).toEqual([])
    expect(profits).toEqual([])
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
    expect(trackCustomer).not.toHaveBeenCalled()
  })
  it("a row from another shop channel (whatsapp_shop) is refused before the mark: no side effects", async () => {
    const { client, profits, updates } = fakeDb({ ussd_shop_orders: shopOrder({ channel: "whatsapp_shop" }) })
    await expect(createOrderHandlers(client).ussd_shop_orders("o1")).rejects.toThrow(/channel/)
    expect(updates).toEqual([])
    expect(profits).toEqual([])
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("already completed: no-op", async () => {
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder({ payment_status: "completed" }) })
    await createOrderHandlers(client).ussd_shop_orders("o1")
    expect(profits).toEqual([])
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("two handler runs racing on the same order: profit credited once, fulfilled once, SMS once (review focus #5)", async () => {
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder({ parent_shop_id: "parent-1", parent_profit_amount: 1.5 }) })
    const h = createOrderHandlers(client)
    const results = await Promise.allSettled([h.ussd_shop_orders("o1"), h.ussd_shop_orders("o1")])
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1)
    expect(profits).toHaveLength(2) // one for the shop, one for the parent
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })
  it("held for MTN registration: no confirmation SMS, no throw", async () => {
    const db = fakeDb({ ussd_shop_orders: shopOrder() })
    fulfillUssdOrder.mockImplementation(async () => {
      db.rows.ussd_shop_orders.order_status = "held_registration"
      return { success: false, message: "held", held: true }
    })
    await createOrderHandlers(db.client).ussd_shop_orders("o1")
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("provider failure (success:false, order left pending) is the manual queue's job: no throw, SMS still sent (as the webhook)", async () => {
    fulfillUssdOrder.mockResolvedValue({ success: false, message: "provider down" })
    const { client } = fakeDb({ ussd_shop_orders: shopOrder() })
    const restore = quiet()
    await createOrderHandlers(client).ussd_shop_orders("o1")
    restore()
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })
  it("library placed the order (order_status processing): accepted", async () => {
    const db = fakeDb({ ussd_shop_orders: shopOrder() })
    fulfillUssdOrder.mockImplementation(async () => {
      db.rows.ussd_shop_orders.order_status = "processing"
      return { success: true, message: "Fulfilled via MTN API" }
    })
    await createOrderHandlers(db.client).ussd_shop_orders("o1")
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })
  it("fulfilment throws: order left pending (not failed), profit still credited, no SMS, then throws (needs_review)", async () => {
    fulfillUssdOrder.mockRejectedValue(new Error("module crashed"))
    const { client, updates, profits, rows } = fakeDb({ ussd_shop_orders: shopOrder() })
    const restore = quiet()
    await expect(createOrderHandlers(client).ussd_shop_orders("o1")).rejects.toThrow(/fulfilment could not be triggered/)
    restore()
    expect(updates.some(u => u.patch.order_status === "pending")).toBe(true)
    expect(updates.some(u => u.patch.order_status === "failed")).toBe(false)
    expect(rows.ussd_shop_orders.order_status).toBe("pending")
    expect(profits).toHaveLength(1)
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("post-state check: library left the order 'failed' (e.g. blacklisted recipient): no SMS, throws at the end (needs_review)", async () => {
    const db = fakeDb({ ussd_shop_orders: shopOrder() })
    fulfillUssdOrder.mockImplementation(async () => {
      db.rows.ussd_shop_orders.order_status = "failed"
      return { success: false, message: "Recipient phone is blacklisted" }
    })
    const restore = quiet()
    await expect(createOrderHandlers(db.client).ussd_shop_orders("o1")).rejects.toThrow(/order_status 'failed' after fulfilment/)
    restore()
    expect(db.profits).toHaveLength(1)
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("post-state check: payment_status no longer 'completed' after fulfilment: throws", async () => {
    const db = fakeDb({ ussd_shop_orders: shopOrder() })
    fulfillUssdOrder.mockImplementation(async () => {
      db.rows.ussd_shop_orders.payment_status = "pending"
      return { success: true, message: "ok" }
    })
    const restore = quiet()
    await expect(createOrderHandlers(db.client).ussd_shop_orders("o1")).rejects.toThrow(/payment_status 'pending' after fulfilment/)
    restore()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("post-state check: re-read fails: throws (fail closed), no SMS", async () => {
    const { client } = fakeDb({ ussd_shop_orders: shopOrder() }, { rereadError: true })
    const restore = quiet()
    await expect(createOrderHandlers(client).ussd_shop_orders("o1")).rejects.toThrow(/unreadable after fulfilment/)
    restore()
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("profit insert fails (real error): customer still served, then throws so the row lands in needs_review", async () => {
    const { client } = fakeDb({ ussd_shop_orders: shopOrder({ parent_shop_id: "parent-1", parent_profit_amount: 1.5 }) }, { profitError: true })
    const restore = quiet()
    await expect(createOrderHandlers(client).ussd_shop_orders("o1")).rejects.toThrow(/shop profit not credited.*parent shop profit not credited/)
    restore()
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })
  it("logs never contain the customer's phone numbers (failure paths)", async () => {
    fulfillUssdOrder.mockRejectedValue(new Error("module crashed"))
    const { client } = fakeDb({ ussd_shop_orders: shopOrder() }, { profitError: true })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await expect(createOrderHandlers(client).ussd_shop_orders("o1")).rejects.toThrow()
    expectNoPhonesLogged([err, warn, log])
    err.mockRestore(); warn.mockRestore(); log.mockRestore()
  })
  it("missing order: throws", async () => {
    const { client } = fakeDb({})
    await expect(createOrderHandlers(client).ussd_shop_orders("o1")).rejects.toThrow(/not found/)
  })
})

describe("ussd_shop_orders fail handler (registry-driven)", () => {
  it("expiry fails an unpaid shop order, guarded on the payable statuses", async () => {
    const { client, updates, rows } = fakeDb({ ussd_shop_orders: shopOrder() })
    await createFailHandlers(client).ussd_shop_orders("o1")
    expect(updates[0]).toMatchObject({
      table: "ussd_shop_orders", patch: { order_status: "failed", payment_status: "failed" }, inCol: "payment_status", inVals: ["pending", "otp_required"],
    })
    expect(rows.ussd_shop_orders).toMatchObject({ order_status: "failed", payment_status: "failed" })
  })
  it("never touches a paid shop order", async () => {
    const { client, updates, rows } = fakeDb({ ussd_shop_orders: shopOrder({ payment_status: "completed", order_status: "processing" }) })
    await createFailHandlers(client).ussd_shop_orders("o1")
    expect(updates).toEqual([])
    expect(rows.ussd_shop_orders).toMatchObject({ order_status: "processing", payment_status: "completed" })
  })
})

/** In-memory HubtelTxStore with an atomic claim, enough for processFulfillment. */
function memStore(over: Partial<HubtelTxRow> = {}): HubtelTxStore & { row: () => HubtelTxRow } {
  let r = {
    session_id: "S1", hubtel_order_id: null, platform: "USSD", order_table: "ussd_shop_orders", order_id: "o1", mobile: "+233200585542",
    expected_amount: 12, amount_paid: null, amount_after_charges: null, state: "awaiting_payment", callback_status: "not_due",
    callback_attempts: 0, callback_last_error: null, callback_sent_at: null, status_check_attempts: 0, last_status_check_at: null,
    paid_at: null, created_at: "2026-10-06T10:00:00.000Z", updated_at: "2026-10-06T10:00:00.000Z", ...over,
  } as HubtelTxRow
  return {
    row: () => r,
    findBySession: async () => ({ ...r }),
    claim: async (_sid, from = ["awaiting_payment"], where) => {
      if (!from.includes(r.state)) return false
      if (where?.callback_status && r.callback_status !== where.callback_status) return false
      if (where?.paid_atIsNull && r.paid_at != null) return false
      r = { ...r, state: "processing" }
      return true
    },
    update: async (_sid, patch) => { r = { ...r, ...patch } as HubtelTxRow },
    updateIf: async (_sid, expect, patch) => {
      if (r.state !== expect.state) return false
      if (expect.callback_status && r.callback_status !== expect.callback_status) return false
      if (expect.paid_atIsNull && r.paid_at != null) return false
      r = { ...r, ...patch } as HubtelTxRow
      return true
    },
    listPendingCallbacks: async () => [],
    listAwaitingPayment: async () => [],
    listStaleProcessing: async () => [],
    listIndeterminate: async () => [],
  }
}

const paid = { sessionId: "S1", hubtelOrderId: "H1", amountPaid: 12.5, amountAfterCharges: 12, isSuccessful: true }

describe("shop order through processFulfillment", () => {
  it("duplicate Hubtel delivery: fulfilled once, shop profit once, SMS once (review focus #5)", async () => {
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder() })
    const store = memStore()
    const restore = quiet() // the loser logs loudly while the winner is processing
    const outcomes = await Promise.all([
      processFulfillment(store, createOrderHandlers(client), paid),
      processFulfillment(store, createOrderHandlers(client), paid),
    ])
    restore()
    expect([...outcomes].sort()).toEqual(["duplicate", "fulfilled"])
    expect(profits).toHaveLength(1)
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(store.row()).toMatchObject({ state: "fulfilled", callback_status: "pending", hubtel_order_id: "H1" })
  })
  it("payment after the order expired: needs_review, handler never runs (review focus #6)", async () => {
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder({ order_status: "failed", payment_status: "failed" }) })
    const store = memStore({ state: "failed" })
    const outcome = await processFulfillment(store, createOrderHandlers(client), paid)
    expect(outcome).toBe("needs_review")
    expect(profits).toHaveLength(0)
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
    expect(store.row()).toMatchObject({ state: "needs_review", callback_status: "pending" })
  })
  it("profit insert fails: customer served, tx row lands in needs_review with the callback due", async () => {
    const { client } = fakeDb({ ussd_shop_orders: shopOrder() }, { profitError: true })
    const store = memStore()
    const restore = quiet()
    const outcome = await processFulfillment(store, createOrderHandlers(client), paid)
    restore()
    expect(outcome).toBe("needs_review")
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(store.row()).toMatchObject({ state: "needs_review", callback_status: "pending", hubtel_order_id: "H1" })
  })
})
