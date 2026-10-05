// lib/ussd-hubtel/payment.test.ts
import { describe, it, expect, vi } from "vitest"
import { parseFulfillmentPayload, decidePayment, processFulfillment } from "./payment"
import type { HubtelTxRow, HubtelTxStore, HubtelFulfillmentInfo } from "./types"

const payload = {
  SessionId: "S1", OrderId: "O1", ExtraData: {},
  OrderInfo: {
    Status: "Paid",
    Payment: { AmountPaid: 11.5, AmountAfterCharges: 10, IsSuccessful: true },
  },
}

describe("parseFulfillmentPayload", () => {
  it("extracts the fields we use", () => {
    expect(parseFulfillmentPayload(payload)).toEqual({
      sessionId: "S1", hubtelOrderId: "O1", amountPaid: 11.5, amountAfterCharges: 10, isSuccessful: true,
    })
  })
  it("rejects payloads without SessionId or Payment", () => {
    expect(parseFulfillmentPayload({ OrderId: "O1" })).toBeNull()
    expect(parseFulfillmentPayload({ SessionId: "S1", OrderInfo: {} })).toBeNull()
    expect(parseFulfillmentPayload(null)).toBeNull()
  })
})

const info = (over: Partial<HubtelFulfillmentInfo> = {}): HubtelFulfillmentInfo =>
  ({ sessionId: "S1", hubtelOrderId: "O1", amountPaid: 11.5, amountAfterCharges: 10, isSuccessful: true, ...over })

describe("decidePayment", () => {
  it("fulfils on exact match, within a cent, and on over-payment", () => {
    expect(decidePayment(10, info())).toBe("fulfil")
    expect(decidePayment(10, info({ amountAfterCharges: 9.995 }))).toBe("fulfil")
    expect(decidePayment(10, info({ amountAfterCharges: 12 }))).toBe("fulfil")
  })
  it("holds under-payment for review (review focus #6)", () => {
    expect(decidePayment(10, info({ amountAfterCharges: 9 }))).toBe("needs_review")
  })
  it("never fulfils an unsuccessful payment", () => {
    expect(decidePayment(10, info({ isSuccessful: false }))).toBe("unsuccessful")
  })
})

function memoryStore(row: Partial<HubtelTxRow> | null) {
  let current: HubtelTxRow | null = row
    ? ({
        session_id: "S1", hubtel_order_id: null, platform: "USSD", order_table: "ussd_orders", order_id: "ord-1",
        mobile: null, expected_amount: 10, amount_paid: null, amount_after_charges: null, state: "awaiting_payment",
        callback_status: "not_due", callback_attempts: 0, callback_last_error: null, callback_sent_at: null,
        status_check_attempts: 0, last_status_check_at: null, paid_at: null, created_at: "", updated_at: "", ...row,
      } as HubtelTxRow)
    : null
  const store: HubtelTxStore = {
    findBySession: async () => current,
    claim: async (_id, from = ["awaiting_payment"]) => {
      if (current && from.includes(current.state)) { current = { ...current, state: "processing" }; return true }
      return false
    },
    listStaleProcessing: async () => [],
    update: async (_id, patch) => { if (current) current = { ...current, ...patch } },
    listPendingCallbacks: async () => [],
    listAwaitingPayment: async () => [],
  }
  return { store, get: () => current! }
}

describe("processFulfillment", () => {
  it("unknown session → no side effects", async () => {
    const { store } = memoryStore(null)
    const h = vi.fn()
    expect(await processFulfillment(store, { ussd_orders: h }, info())).toBe("unknown_session")
    expect(h).not.toHaveBeenCalled()
  })

  it("fulfils once, marks callback pending, records amounts", async () => {
    const m = memoryStore({})
    const h = vi.fn().mockResolvedValue(undefined)
    expect(await processFulfillment(m.store, { ussd_orders: h }, info())).toBe("fulfilled")
    expect(h).toHaveBeenCalledWith("ord-1")
    expect(m.get()).toMatchObject({
      state: "fulfilled", callback_status: "pending", hubtel_order_id: "O1", amount_paid: 11.5, amount_after_charges: 10,
    })
    expect(m.get().paid_at).toBeTruthy()
  })

  it("a duplicate delivery never fulfils twice (review focus #1)", async () => {
    const m = memoryStore({})
    const h = vi.fn().mockResolvedValue(undefined)
    await processFulfillment(m.store, { ussd_orders: h }, info())
    expect(await processFulfillment(m.store, { ussd_orders: h }, info())).toBe("duplicate")
    expect(h).toHaveBeenCalledTimes(1)
  })

  it("two concurrent deliveries: exactly one wins the claim", async () => {
    const m = memoryStore({})
    const h = vi.fn().mockResolvedValue(undefined)
    const results = await Promise.all([
      processFulfillment(m.store, { ussd_orders: h }, info()),
      processFulfillment(m.store, { ussd_orders: h }, info()),
    ])
    expect(results.sort()).toEqual(["duplicate", "fulfilled"])
    expect(h).toHaveBeenCalledTimes(1)
  })

  it("under-payment: no fulfilment, state needs_review, callback still pending", async () => {
    const m = memoryStore({})
    const h = vi.fn()
    expect(await processFulfillment(m.store, { ussd_orders: h }, info({ amountAfterCharges: 5 }))).toBe("needs_review")
    expect(h).not.toHaveBeenCalled()
    expect(m.get()).toMatchObject({ state: "needs_review", callback_status: "pending" })
  })

  it("unsuccessful payment: failed, no callback due", async () => {
    const m = memoryStore({})
    const h = vi.fn()
    expect(await processFulfillment(m.store, { ussd_orders: h }, info({ isSuccessful: false }))).toBe("unsuccessful")
    expect(m.get()).toMatchObject({ state: "failed", callback_status: "not_due" })
  })

  it("unsuccessful payment leaves paid_at null", async () => {
    const m = memoryStore({})
    await processFulfillment(m.store, { ussd_orders: vi.fn() }, info({ isSuccessful: false }))
    expect(m.get().paid_at).toBeNull()
  })

  it("late payment on an expired (failed) row: recorded, held for review, handler not called", async () => {
    const m = memoryStore({ state: "failed" })
    const h = vi.fn()
    expect(await processFulfillment(m.store, { ussd_orders: h }, info())).toBe("needs_review")
    expect(h).not.toHaveBeenCalled()
    expect(m.get()).toMatchObject({
      state: "needs_review", callback_status: "pending", hubtel_order_id: "O1", amount_paid: 11.5, amount_after_charges: 10,
    })
  })

  it("failed row already declined by Hubtel (amount_paid set) stays a duplicate", async () => {
    const m = memoryStore({ state: "failed", amount_paid: 10 })
    const h = vi.fn()
    expect(await processFulfillment(m.store, { ussd_orders: h }, info())).toBe("duplicate")
    expect(h).not.toHaveBeenCalled()
    expect(m.get()).toMatchObject({ state: "failed", amount_paid: 10 })
  })

  it("two concurrent late-payment deliveries: one needs_review, one duplicate", async () => {
    const m = memoryStore({ state: "failed" })
    const h = vi.fn()
    const results = await Promise.all([
      processFulfillment(m.store, { ussd_orders: h }, info()),
      processFulfillment(m.store, { ussd_orders: h }, info()),
    ])
    expect(results.sort()).toEqual(["duplicate", "needs_review"])
    expect(h).not.toHaveBeenCalled()
  })

  it("a throwing handler → needs_review with callback pending (always-success policy)", async () => {
    const m = memoryStore({})
    const h = vi.fn().mockRejectedValue(new Error("provider down"))
    expect(await processFulfillment(m.store, { ussd_orders: h }, info())).toBe("needs_review")
    expect(m.get()).toMatchObject({ state: "needs_review", callback_status: "pending" })
  })

  it("an order table without a handler yet → needs_review, callback pending", async () => {
    const m = memoryStore({ order_table: "airtime_orders" })
    expect(await processFulfillment(m.store, { ussd_orders: vi.fn() }, info())).toBe("needs_review")
    expect(m.get()).toMatchObject({ state: "needs_review", callback_status: "pending" })
  })
})
