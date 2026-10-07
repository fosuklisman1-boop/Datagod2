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
  /** Reads of shop_profits (select ... eq ... limit) fail. */
  profitReadError?: boolean
  /**
   * OPT-IN: enforce migration 0108's UNIQUE (ussd_shop_order_id, shop_id) and answer 23505 on a
   * duplicate. Off by default, so once-only tests stand on the handler's own gates (they assert the
   * number of insert CALLS), not on a constraint the fake would otherwise invent.
   */
  uniqueIndex?: boolean
}

/**
 * Table-aware fake. Reads return a COPY of rows[table] (a concurrent reader keeps its stale view,
 * like a real DB read). Every update().eq().in(col, vals) applies only when rows[table][col] is in
 * vals (like the real conditional update), synchronously at call time for the .select() form (so two
 * racing handlers get exactly one winner). `profitInserts` counts every shop_profits insert CALL
 * (including ones refused with 23505); the unique key is only enforced with opts.uniqueIndex.
 */
function fakeDb(rows: Record<string, any>, opts: FakeOpts = {}) {
  const updates: Array<{ table: string; patch: any; inCol?: string; inVals?: string[] }> = []
  const profits: any[] = [...(opts.existingProfits ?? [])]
  const profitInserts: any[] = []
  const reads: Record<string, number> = {}
  const client: any = {
    from(table: string) {
      return {
        select: () => {
          // eq() filters are collected for shop_profits reads (select().eq().eq().limit()).
          const filters: Array<[string, unknown]> = []
          const q: any = {
            eq: (col: string, val: unknown) => { filters.push([col, val]); return q },
            maybeSingle: async () => {
              reads[table] = (reads[table] ?? 0) + 1
              if (opts.rereadError && table === "ussd_shop_orders" && reads[table] > 1) {
                return { data: null, error: { message: "statement timeout" } }
              }
              return { data: rows[table] ? { ...rows[table] } : null, error: null }
            },
            limit: async (n: number) => {
              if (table !== "shop_profits") throw new Error(`fake: limit() only supported on shop_profits, not ${table}`)
              if (opts.profitReadError) return { data: null, error: { message: "statement timeout" } }
              const hits = profits.filter(p => filters.every(([c, v]) => p[c] === v)).slice(0, n)
              return { data: hits.map(p => ({ id: p.id ?? "p", profit_amount: p.profit_amount })), error: null }
            },
          }
          return q
        },
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
            profitInserts.push(...list)
            if (opts.profitError) return { error: { code: "XX000", message: "profit insert failed" } }
            if (opts.uniqueIndex) {
              for (const p of list) {
                if (profits.some(q => q.ussd_shop_order_id === p.ussd_shop_order_id && q.shop_id === p.shop_id)) {
                  return { error: { code: "23505", message: "duplicate key value violates unique constraint" } }
                }
              }
            }
            profits.push(...list)
          }
          return { error: null }
        },
      }
    },
  }
  return { client, updates, profits, profitInserts, rows }
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
  it("profit already credited (unique violation 23505, same amounts): treated as credited, no duplicate row, no throw", async () => {
    const existing = [
      { shop_id: "shop-1", ussd_shop_order_id: "o1", profit_amount: 1 },
      { shop_id: "parent-1", ussd_shop_order_id: "o1", profit_amount: 1.5 },
    ]
    const { client, profits, profitInserts } = fakeDb(
      { ussd_shop_orders: shopOrder({ profit_amount: 1, parent_shop_id: "parent-1", parent_profit_amount: 1.5 }) },
      { existingProfits: existing, uniqueIndex: true },
    )
    const restore = quiet()
    await createOrderHandlers(client).ussd_shop_orders("o1")
    restore()
    expect(profits).toEqual(existing)
    expect(profitInserts).toHaveLength(2) // both attempted, both refused by the (0108) key
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })
  it("(M2) 23505 but the existing credit has a DIFFERENT amount: customer served, then throws (needs_review)", async () => {
    const existing = [{ shop_id: "shop-1", ussd_shop_order_id: "o1", profit_amount: 0.5 }]
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder({ profit_amount: 2 }) }, { existingProfits: existing, uniqueIndex: true })
    const restore = quiet()
    await expect(createOrderHandlers(client).ussd_shop_orders("o1")).rejects.toThrow(
      /shop profit already credited with a different amount \(0\.5, expected 2\)/
    )
    restore()
    expect(profits).toEqual(existing)
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })
  it("(M2) 23505 and the existing credit cannot be re-read: throws (fail closed)", async () => {
    const existing = [{ shop_id: "shop-1", ussd_shop_order_id: "o1", profit_amount: 2 }]
    const { client } = fakeDb({ ussd_shop_orders: shopOrder({ profit_amount: 2 }) }, { existingProfits: existing, uniqueIndex: true, profitReadError: true })
    const restore = quiet()
    await expect(createOrderHandlers(client).ussd_shop_orders("o1")).rejects.toThrow(/shop profit: existing credit could not be verified/)
    restore()
  })
  it("(M2) parent_shop_id === shop_id: parent credit SKIPPED, shop credited once, customer served, then throws", async () => {
    const { client, profits, profitInserts } = fakeDb({ ussd_shop_orders: shopOrder({ parent_shop_id: "shop-1", parent_profit_amount: 1.5 }) })
    const restore = quiet()
    await expect(createOrderHandlers(client).ussd_shop_orders("o1")).rejects.toThrow(/parent shop is the shop itself/)
    restore()
    expect(profitInserts).toHaveLength(1)
    expect(profits).toEqual([expect.objectContaining({ shop_id: "shop-1", profit_amount: 2 })])
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
  it("already completed: no-op, but warns with the order id only (M6)", async () => {
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder({ payment_status: "completed" }) })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await createOrderHandlers(client).ussd_shop_orders("o1")
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).toContain("o1")
    expectNoPhonesLogged([warn])
    warn.mockRestore()
    expect(profits).toEqual([])
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("two handler runs racing on the same order: profit credited once, fulfilled once, SMS once (review focus #5)", async () => {
    const { client, profits, profitInserts } = fakeDb({ ussd_shop_orders: shopOrder({ parent_shop_id: "parent-1", parent_profit_amount: 1.5 }) })
    const h = createOrderHandlers(client)
    const results = await Promise.allSettled([h.ussd_shop_orders("o1"), h.ussd_shop_orders("o1")])
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1)
    // No unique key in the fake: the handler's conditional mark alone keeps it to ONE insert per shop.
    expect(profitInserts).toHaveLength(2) // one for the shop, one for the parent
    expect(profits).toHaveLength(2)
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
    callback_attempts: 0, callback_last_error: null, callback_sent_at: null, review_reason: null, status_check_attempts: 0, last_status_check_at: null,
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
    const { client, profits, profitInserts } = fakeDb({ ussd_shop_orders: shopOrder() })
    const store = memStore()
    const restore = quiet() // the loser logs loudly while the winner is processing
    const outcomes = await Promise.all([
      processFulfillment(store, createOrderHandlers(client), paid),
      processFulfillment(store, createOrderHandlers(client), paid),
    ])
    restore()
    expect([...outcomes].sort()).toEqual(["duplicate", "fulfilled"])
    expect(profitInserts).toHaveLength(1) // ONE insert call: the claim alone guarantees it (no DB key in the fake)
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

describe("shop airtime row through Plan 2's airtime_orders handler (no fork)", () => {
  // Exactly what flows/shop-airtime.ts writes (createShopAirtimeOrder shape).
  const shopAirtime = (over: Record<string, unknown> = {}) => ({
    id: "t1", network: "MTN", beneficiary_phone: "0244123456", dialing_phone: "+233200585542", airtime_amount: 9.35,
    fee_amount: 0.65, total_paid: 10, status: "pending_payment", payment_status: "pending_payment",
    user_id: null, shop_id: "shop-1", merchant_commission: 0.19, channel: "ussd_shop", ...over,
  })
  /**
   * Like the real lib/airtime-service.ts markAirtimeOrderPaid for a shop row: marks it paid and
   * (because shop_id + merchant_commission > 0) inserts the shop_profits credit itself.
   */
  const realisticMark = (db: ReturnType<typeof fakeDb>) => async (id: string) => {
    const row = db.rows.airtime_orders
    if (row.payment_status === "completed") return { success: true, alreadyProcessed: true }
    Object.assign(row, { payment_status: "completed", status: "pending" })
    if (row.merchant_commission > 0 && row.shop_id) {
      db.profits.push({ shop_id: row.shop_id, airtime_order_id: id, profit_amount: row.merchant_commission, status: "credited" })
    }
    return { success: true }
  }

  it("marks paid once via markAirtimeOrderPaid (which owns the shop credit), then SMSes recipient and payer once each", async () => {
    const db = fakeDb({ airtime_orders: shopAirtime() })
    markAirtimeOrderPaid.mockImplementation(realisticMark(db))
    await createOrderHandlers(db.client).airtime_orders("t1")
    expect(markAirtimeOrderPaid).toHaveBeenCalledTimes(1)
    expect(markAirtimeOrderPaid.mock.calls[0][0]).toBe("t1")
    expect(db.profits).toEqual([{ shop_id: "shop-1", airtime_order_id: "t1", profit_amount: 0.19, status: "credited" }])
    expect(sendSMS.mock.calls.map(c => c[0].phone)).toEqual(["0244123456", "+233200585542"])
    // The handler itself never writes a profit row or marks the order: the library is the single path.
    expect(db.updates).toEqual([])
  })
  it("(final I2) library's commission insert silently failed: customer still SMSed, THEN throws (needs_review)", async () => {
    const db = fakeDb({ airtime_orders: shopAirtime() })
    markAirtimeOrderPaid.mockImplementation(async () => {
      Object.assign(db.rows.airtime_orders, { payment_status: "completed", status: "pending" }) // no credit row
      return { success: true }
    })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(createOrderHandlers(db.client).airtime_orders("t1")).rejects.toThrow(
      /airtime_orders t1: airtime paid but shop commission not found in shop_profits: needs manual review/
    )
    expect(sendSMS.mock.calls.map(c => c[0].phone)).toEqual(["0244123456", "+233200585542"]) // notified first
    expect(err).toHaveBeenCalled()
    expectNoPhonesLogged([err, warn])
    err.mockRestore(); warn.mockRestore()
  })
  it("(final I2) a credit for ANOTHER shop does not count", async () => {
    const db = fakeDb({ airtime_orders: shopAirtime() })
    markAirtimeOrderPaid.mockImplementation(async () => {
      Object.assign(db.rows.airtime_orders, { payment_status: "completed", status: "pending" })
      db.profits.push({ id: "px", shop_id: "shop-2", airtime_order_id: "t1", profit_amount: 0.19, status: "credited" })
      return { success: true }
    })
    const restore = quiet()
    await expect(createOrderHandlers(db.client).airtime_orders("t1")).rejects.toThrow(/shop commission not found/)
    restore()
  })
  it("(final I2) commission check unreadable: fails closed (throws) after the SMS, no phone logged", async () => {
    const db = fakeDb({ airtime_orders: shopAirtime() }, { profitReadError: true })
    markAirtimeOrderPaid.mockImplementation(realisticMark(db))
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(createOrderHandlers(db.client).airtime_orders("t1")).rejects.toThrow(/shop commission not found/)
    expect(sendSMS).toHaveBeenCalledTimes(2)
    expect(err).toHaveBeenCalled()
    expectNoPhonesLogged([err, warn])
    err.mockRestore(); warn.mockRestore()
  })
  it("(final I2) main-menu row (shop_id null) or zero commission: no shop_profits check at all", async () => {
    for (const over of [{ shop_id: null, merchant_commission: 0, channel: "ussd" }, { merchant_commission: 0 }]) {
      // profitReadError would make any check throw: resolving proves no check ran.
      const db = fakeDb({ airtime_orders: shopAirtime(over) }, { profitReadError: true })
      markAirtimeOrderPaid.mockImplementation(realisticMark(db))
      await createOrderHandlers(db.client).airtime_orders("t1")
      expect(db.profits).toEqual([])
    }
  })
  it("not payable (expired/failed): throws before the library, no credit, no SMS", async () => {
    const db = fakeDb({ airtime_orders: shopAirtime({ status: "failed", payment_status: "failed" }) })
    markAirtimeOrderPaid.mockImplementation(realisticMark(db))
    await expect(createOrderHandlers(db.client).airtime_orders("t1")).rejects.toThrow(/not in a payable state: failed/)
    expect(markAirtimeOrderPaid).not.toHaveBeenCalled()
    expect(db.profits).toEqual([])
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("library reports success but the row is not 'completed' on re-read: throws, no SMS", async () => {
    const db = fakeDb({ airtime_orders: shopAirtime() })
    markAirtimeOrderPaid.mockResolvedValue({ success: true }) // its own update silently failed
    await expect(createOrderHandlers(db.client).airtime_orders("t1")).rejects.toThrow(/not marked paid.*pending_payment/)
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("already completed: no library call, no SMS", async () => {
    const db = fakeDb({ airtime_orders: shopAirtime({ payment_status: "completed" }) })
    markAirtimeOrderPaid.mockImplementation(realisticMark(db))
    await createOrderHandlers(db.client).airtime_orders("t1")
    expect(markAirtimeOrderPaid).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("duplicate Hubtel delivery through processFulfillment: library once, shop credit once, SMS once each", async () => {
    const db = fakeDb({ airtime_orders: shopAirtime() })
    markAirtimeOrderPaid.mockImplementation(realisticMark(db))
    const store = memStore({ order_table: "airtime_orders", order_id: "t1", expected_amount: 10 })
    const restore = quiet()
    const outcomes = await Promise.all([
      processFulfillment(store, createOrderHandlers(db.client), { ...paid, amountPaid: 10.1, amountAfterCharges: 10 }),
      processFulfillment(store, createOrderHandlers(db.client), { ...paid, amountPaid: 10.1, amountAfterCharges: 10 }),
    ])
    restore()
    expect([...outcomes].sort()).toEqual(["duplicate", "fulfilled"])
    expect(markAirtimeOrderPaid).toHaveBeenCalledTimes(1)
    expect(db.profits).toHaveLength(1)
    expect(sendSMS).toHaveBeenCalledTimes(2) // recipient + payer, once each
    expect(store.row()).toMatchObject({ state: "fulfilled", callback_status: "pending" })
  })
})

describe("shop voucher row through Plan 2's results_checker_orders handler (no fork)", () => {
  // Exactly what flows/shop-rc.ts writes (createShopRcOrder shape).
  const shopRc = (over: Record<string, unknown> = {}) => ({
    id: "r1", reference_code: "RC-AB123", exam_board: "WASSCE", quantity: 2, customer_name: "USSD Customer", customer_email: null,
    customer_phone: "0200585542", unit_price: 22, fee_amount: 0, total_paid: 44, shop_id: "shop-1", merchant_commission: 4,
    status: "pending_payment", payment_status: "pending_payment", dialing_phone: "+233200585542", channel: "ussd_shop", ...over,
  })
  /**
   * Like the real lib/results-checker-service.ts fulfillPaidResultsCheckerOrder: returns early on a
   * completed/failed order, else assigns vouchers, marks completed, credits merchant_commission to
   * shop_id (results_checker_order_id) and SMSes the PINs. `credit: false` = its swallowed insert failed.
   */
  const realisticFulfil = (db: ReturnType<typeof fakeDb>, opts: { credit?: boolean; stock?: boolean } = {}) => async (id: string) => {
    const row = db.rows.results_checker_orders
    if (row.status === "completed") return { success: true, status: "completed", message: "Already completed", newlyPaid: false }
    if (row.status === "failed") return { success: false, status: "failed", message: "Order already failed", newlyPaid: false }
    if (opts.stock === false) {
      Object.assign(row, { status: "pending", payment_status: "completed" })
      return { success: false, status: "pending", message: "Stock exhausted", newlyPaid: true }
    }
    Object.assign(row, { status: "completed", payment_status: "completed" })
    if (opts.credit !== false && row.merchant_commission > 0 && row.shop_id) {
      db.profits.push({ id: "p1", shop_id: row.shop_id, results_checker_order_id: id, profit_amount: row.merchant_commission, status: "credited" })
    }
    return { success: true, status: "completed", message: "Vouchers delivered", newlyPaid: true }
  }

  it("marks payment and lets fulfillPaidResultsCheckerOrder deliver and credit the shop commission once", async () => {
    const db = fakeDb({ results_checker_orders: shopRc() })
    fulfillPaidResultsCheckerOrder.mockImplementation(realisticFulfil(db))
    await createOrderHandlers(db.client).results_checker_orders("r1")
    expect(fulfillPaidResultsCheckerOrder).toHaveBeenCalledTimes(1)
    expect(fulfillPaidResultsCheckerOrder).toHaveBeenCalledWith("r1")
    expect(db.updates[0]).toMatchObject({ table: "results_checker_orders", patch: { payment_status: "completed" }, inCol: "payment_status", inVals: ["pending_payment", "otp_required"] })
    // The handler never writes a profit row itself: the library is the single credit path.
    expect(db.profits).toEqual([{ id: "p1", shop_id: "shop-1", results_checker_order_id: "r1", profit_amount: 4, status: "credited" }])
  })
  it("library delivered but its (swallowed) commission insert failed: throws AFTER delivery so the row lands in needs_review", async () => {
    const db = fakeDb({ results_checker_orders: shopRc() })
    fulfillPaidResultsCheckerOrder.mockImplementation(realisticFulfil(db, { credit: false }))
    await expect(createOrderHandlers(db.client).results_checker_orders("r1")).rejects.toThrow(/shop commission not found/)
    expect(fulfillPaidResultsCheckerOrder).toHaveBeenCalledTimes(1) // the customer already has the PINs
    expect(db.profits).toEqual([])
  })
  it("a profit row for ANOTHER shop does not count as this shop's commission", async () => {
    const db = fakeDb({ results_checker_orders: shopRc() })
    fulfillPaidResultsCheckerOrder.mockImplementation(realisticFulfil(db, { credit: false }))
    db.profits.push({ id: "px", shop_id: "shop-2", results_checker_order_id: "r1", profit_amount: 4, status: "credited" })
    await expect(createOrderHandlers(db.client).results_checker_orders("r1")).rejects.toThrow(/shop commission not found/)
  })
  it("commission check unreadable: fails closed (throws), never logs a phone", async () => {
    const db = fakeDb({ results_checker_orders: shopRc() }, { profitReadError: true })
    fulfillPaidResultsCheckerOrder.mockImplementation(realisticFulfil(db))
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await expect(createOrderHandlers(db.client).results_checker_orders("r1")).rejects.toThrow(/shop commission not found/)
    expect(err).toHaveBeenCalled()
    expectNoPhonesLogged([err, warn, log])
    err.mockRestore(); warn.mockRestore(); log.mockRestore()
  })
  it("(M5) commission credited but status not 'completed' after the library: ONE throw naming the status", async () => {
    const db = fakeDb({ results_checker_orders: shopRc() })
    const real = realisticFulfil(db)
    fulfillPaidResultsCheckerOrder.mockImplementation(async (id: string) => {
      const r = await real(id)
      db.rows.results_checker_orders.status = "processing" // its final update was swallowed
      return r
    })
    const restore = quiet()
    const p = createOrderHandlers(db.client).results_checker_orders("r1")
    await expect(p).rejects.toThrow(/status 'processing' after fulfilment/)
    await expect(p).rejects.not.toThrow(/shop commission not found/)
    restore()
  })
  it("(M5) status wrong AND commission missing: one combined error with both problems", async () => {
    const db = fakeDb({ results_checker_orders: shopRc() })
    const real = realisticFulfil(db, { credit: false })
    fulfillPaidResultsCheckerOrder.mockImplementation(async (id: string) => {
      const r = await real(id)
      db.rows.results_checker_orders.status = "processing"
      return r
    })
    const restore = quiet()
    await expect(createOrderHandlers(db.client).results_checker_orders("r1")).rejects.toThrow(
      /status 'processing' after fulfilment.*shop commission not found/
    )
    restore()
  })
  it("shop row with zero commission (markup 0): no commission expected, no check, resolves", async () => {
    const db = fakeDb({ results_checker_orders: shopRc({ merchant_commission: 0 }) }, { profitReadError: true })
    fulfillPaidResultsCheckerOrder.mockImplementation(realisticFulfil(db))
    await createOrderHandlers(db.client).results_checker_orders("r1")
    expect(db.profits).toEqual([])
  })
  it("out of stock after payment: throws (needs_review; admin delivers AND credits the shop by hand, D14)", async () => {
    const db = fakeDb({ results_checker_orders: shopRc() })
    fulfillPaidResultsCheckerOrder.mockImplementation(realisticFulfil(db, { stock: false }))
    await expect(createOrderHandlers(db.client).results_checker_orders("r1")).rejects.toThrow(/out of stock.*credit the shop commission/)
    expect(db.profits).toEqual([])
  })
  it("late payment on an expired (failed) shop voucher order: throws before the library, no credit", async () => {
    const db = fakeDb({ results_checker_orders: shopRc({ status: "failed", payment_status: "failed" }) })
    fulfillPaidResultsCheckerOrder.mockImplementation(realisticFulfil(db))
    await expect(createOrderHandlers(db.client).results_checker_orders("r1")).rejects.toThrow(/not in a payable state/)
    expect(fulfillPaidResultsCheckerOrder).not.toHaveBeenCalled()
    expect(db.profits).toEqual([])
  })
  it("duplicate Hubtel delivery through processFulfillment: library once, commission once", async () => {
    const db = fakeDb({ results_checker_orders: shopRc() })
    fulfillPaidResultsCheckerOrder.mockImplementation(realisticFulfil(db))
    const store = memStore({ order_table: "results_checker_orders", order_id: "r1", expected_amount: 44 })
    const restore = quiet()
    const outcomes = await Promise.all([
      processFulfillment(store, createOrderHandlers(db.client), { ...paid, amountPaid: 44.5, amountAfterCharges: 44 }),
      processFulfillment(store, createOrderHandlers(db.client), { ...paid, amountPaid: 44.5, amountAfterCharges: 44 }),
    ])
    restore()
    expect([...outcomes].sort()).toEqual(["duplicate", "fulfilled"])
    expect(fulfillPaidResultsCheckerOrder).toHaveBeenCalledTimes(1)
    expect(db.profits).toHaveLength(1)
    expect(store.row()).toMatchObject({ state: "fulfilled", callback_status: "pending" })
  })
  it("missing commission through processFulfillment: tx row lands in needs_review with the callback due", async () => {
    const db = fakeDb({ results_checker_orders: shopRc() })
    fulfillPaidResultsCheckerOrder.mockImplementation(realisticFulfil(db, { credit: false }))
    const store = memStore({ order_table: "results_checker_orders", order_id: "r1", expected_amount: 44 })
    const restore = quiet()
    const outcome = await processFulfillment(store, createOrderHandlers(db.client), { ...paid, amountPaid: 44.5, amountAfterCharges: 44 })
    restore()
    expect(outcome).toBe("needs_review")
    expect(store.row()).toMatchObject({ state: "needs_review", callback_status: "pending" })
  })
})
