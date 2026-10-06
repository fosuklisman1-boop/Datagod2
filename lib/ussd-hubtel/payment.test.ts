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
  it("fails closed on a non-finite amount", () => {
    expect(decidePayment(10, info({ amountAfterCharges: NaN }))).toBe("needs_review")
    expect(decidePayment(10, info({ amountAfterCharges: Infinity }))).toBe("needs_review")
  })
  it("never fulfils an unsuccessful payment", () => {
    expect(decidePayment(10, info({ isSuccessful: false }))).toBe("unsuccessful")
  })
})

/** Mirrors the optional extra claim guards of the Supabase store. */
const whereOk = (r: HubtelTxRow, w?: { callback_status?: HubtelTxRow["callback_status"]; paid_atIsNull?: boolean }) =>
  (!w?.callback_status || r.callback_status === w.callback_status) && (!w?.paid_atIsNull || r.paid_at == null)

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
    claim: async (_id, from = ["awaiting_payment"], where) => {
      if (current && from.includes(current.state) && whereOk(current, where)) { current = { ...current, state: "processing" }; return true }
      return false
    },
    updateIf: async (_id, g, patch) => {
      if (current && current.state === g.state && whereOk(current, g)) { current = { ...current, ...patch }; return true }
      return false
    },
    listStaleProcessing: async () => [],
    listIndeterminate: async () => [],
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

  // Behaviour change (M1): an unsuccessful delivery no longer leaves a terminal failed row. It
  // releases the claim back to awaiting_payment with nothing recorded; the status-check/expiry
  // path owns the row from there, and a later successful delivery is processed normally.
  it("unsuccessful payment: claim released back to awaiting_payment, nothing recorded, no callback due", async () => {
    const m = memoryStore({})
    const h = vi.fn()
    expect(await processFulfillment(m.store, { ussd_orders: h }, info({ isSuccessful: false }))).toBe("unsuccessful")
    expect(h).not.toHaveBeenCalled()
    expect(m.get()).toMatchObject({
      state: "awaiting_payment", callback_status: "not_due", amount_paid: null, amount_after_charges: null, hubtel_order_id: null,
    })
  })

  it("unsuccessful payment leaves paid_at null", async () => {
    const m = memoryStore({})
    await processFulfillment(m.store, { ussd_orders: vi.fn() }, info({ isSuccessful: false }))
    expect(m.get().paid_at).toBeNull()
  })

  it("unsuccessful then successful on the same session: the second delivery fulfils", async () => {
    const m = memoryStore({})
    const h = vi.fn().mockResolvedValue(undefined)
    expect(await processFulfillment(m.store, { ussd_orders: h }, info({ isSuccessful: false }))).toBe("unsuccessful")
    expect(await processFulfillment(m.store, { ussd_orders: h }, info())).toBe("fulfilled")
    expect(h).toHaveBeenCalledTimes(1)
    expect(m.get()).toMatchObject({ state: "fulfilled", callback_status: "pending", hubtel_order_id: "O1", amount_paid: 11.5 })
  })

  it("payment fields are stored BEFORE the order handler runs (crash mid-handler keeps OrderId + paid_at)", async () => {
    const m = memoryStore({})
    let seen: HubtelTxRow | null = null
    const h = vi.fn(async () => { seen = await m.store.findBySession("S1") })
    await processFulfillment(m.store, { ussd_orders: h }, info())
    expect(seen).toMatchObject({ hubtel_order_id: "O1", amount_paid: 11.5, amount_after_charges: 10 })
    expect(seen!.paid_at).toBeTruthy()
  })

  it("a handler that never returns (crash/timeout) still leaves OrderId + paid_at on the row", async () => {
    const m = memoryStore({})
    const h = vi.fn(() => new Promise<void>(() => {})) // never settles, like a killed function
    void processFulfillment(m.store, { ussd_orders: h }, info())
    await new Promise(r => setTimeout(r, 0))
    expect(h).toHaveBeenCalled()
    expect(m.get()).toMatchObject({ state: "processing", hubtel_order_id: "O1", amount_paid: 11.5 })
    expect(m.get().paid_at).toBeTruthy()
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

  // Behaviour change (I2): the late-payment guard keys on paid_at, not amount_paid. A failed row
  // that recorded a DECLINED attempt (amount_paid set, paid_at null) was never paid, so a later
  // successful payment for that session is recovered to needs_review instead of dropped.
  it("failed row with a declined attempt recorded (amount_paid set, paid_at null) + success -> needs_review", async () => {
    const m = memoryStore({ state: "failed", amount_paid: 10, paid_at: null })
    const h = vi.fn()
    expect(await processFulfillment(m.store, { ussd_orders: h }, info())).toBe("needs_review")
    expect(h).not.toHaveBeenCalled()
    expect(m.get()).toMatchObject({ state: "needs_review", callback_status: "pending", hubtel_order_id: "O1", amount_paid: 11.5 })
  })

  it("stale snapshot: row expired between the first read and the claim -> recovered to needs_review", async () => {
    let cur: HubtelTxRow = {
      session_id: "S1", hubtel_order_id: null, platform: "USSD", order_table: "ussd_orders", order_id: "ord-1",
      mobile: null, expected_amount: 10, amount_paid: null, amount_after_charges: null, state: "awaiting_payment",
      callback_status: "not_due", callback_attempts: 0, callback_last_error: null, callback_sent_at: null,
      status_check_attempts: 0, last_status_check_at: null, paid_at: null, created_at: "", updated_at: "",
    }
    let reads = 0
    const store: HubtelTxStore = {
      // First read sees awaiting_payment; expiry then claims+fails the row before our claim.
      findBySession: async () => {
        reads++
        if (reads === 1) { const snap = { ...cur }; cur = { ...cur, state: "failed" }; return snap }
        return cur
      },
      claim: async (_id, from = ["awaiting_payment"], where) => {
        if (from.includes(cur.state) && whereOk(cur, where)) { cur = { ...cur, state: "processing" }; return true }
        return false
      },
      update: async (_id, p) => { cur = { ...cur, ...p } },
      updateIf: async () => false,
      listPendingCallbacks: async () => [], listAwaitingPayment: async () => [], listStaleProcessing: async () => [], listIndeterminate: async () => [],
    }
    const h = vi.fn()
    expect(await processFulfillment(store, { ussd_orders: h }, info())).toBe("needs_review")
    expect(h).not.toHaveBeenCalled()
    expect(cur).toMatchObject({ state: "needs_review", callback_status: "pending", hubtel_order_id: "O1", amount_paid: 11.5 })
    expect(cur.paid_at).toBeTruthy()
  })

  it("a successful payment that ends as 'duplicate' on a processing row is logged loudly", async () => {
    const m = memoryStore({ state: "processing" })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await processFulfillment(m.store, { ussd_orders: vi.fn() }, info())).toBe("duplicate")
    expect(err.mock.calls.some(c => String(c[0]).includes("successful payment not recorded"))).toBe(true)
    expect(JSON.stringify(err.mock.calls)).toContain("S1")
    err.mockRestore()
  })

  it("a successful payment on a failed row that already has paid_at stays duplicate and is logged loudly", async () => {
    const m = memoryStore({ state: "failed", paid_at: "2026-10-05T10:00:00Z", amount_paid: 10 })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await processFulfillment(m.store, { ussd_orders: vi.fn() }, info())).toBe("duplicate")
    expect(err.mock.calls.some(c => String(c[0]).includes("successful payment not recorded"))).toBe(true)
    err.mockRestore()
  })

  it("(a) late success on an indeterminate-expiry row (needs_review/not_due/paid_at null) -> recovered, handler not called", async () => {
    const m = memoryStore({ state: "needs_review", callback_status: "not_due", paid_at: null })
    const h = vi.fn()
    expect(await processFulfillment(m.store, { ussd_orders: h }, info())).toBe("needs_review")
    expect(h).not.toHaveBeenCalled()
    expect(m.get()).toMatchObject({
      state: "needs_review", callback_status: "pending", hubtel_order_id: "O1", amount_paid: 11.5, amount_after_charges: 10,
    })
    expect(m.get().paid_at).toBeTruthy()
  })

  it("(b) a needs_review row with callback pending/sent or paid_at set stays duplicate", async () => {
    for (const row of [
      { state: "needs_review" as const, callback_status: "pending" as const, paid_at: null },
      { state: "needs_review" as const, callback_status: "sent" as const, paid_at: null },
      { state: "needs_review" as const, callback_status: "not_due" as const, paid_at: "2026-10-05T10:00:00Z" },
    ]) {
      const m = memoryStore(row)
      const h = vi.fn()
      expect(await processFulfillment(m.store, { ussd_orders: h }, info())).toBe("duplicate")
      expect(h).not.toHaveBeenCalled()
      expect(m.get()).toMatchObject({ state: "needs_review", callback_status: row.callback_status, hubtel_order_id: null })
    }
  })

  it("(c) two concurrent late successes on an indeterminate-expiry row: one recovers, one duplicate", async () => {
    const m = memoryStore({ state: "needs_review", callback_status: "not_due", paid_at: null })
    const h = vi.fn()
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const results = await Promise.all([
      processFulfillment(m.store, { ussd_orders: h }, info()),
      processFulfillment(m.store, { ussd_orders: h }, info()),
    ])
    err.mockRestore()
    expect(results.sort()).toEqual(["duplicate", "needs_review"])
    expect(h).not.toHaveBeenCalled()
    expect(m.get()).toMatchObject({ state: "needs_review", callback_status: "pending", hubtel_order_id: "O1" })
  })

  it("(ABA) a second recoverer that read the parked row before the first finished cannot re-claim or overwrite", async () => {
    const parkedSnapshot = { state: "needs_review" as const, callback_status: "not_due" as const, paid_at: null }
    const m = memoryStore(parkedSnapshot)
    const h = vi.fn()
    // Recoverer A completes; then the callback is sent.
    expect(await processFulfillment(m.store, { ussd_orders: h }, info())).toBe("needs_review")
    await m.store.update("S1", { callback_status: "sent" })
    const afterA = { ...m.get() }
    // Recoverer B read the row while it was still parked: its reads return that stale snapshot.
    const staleRow = { ...afterA, ...parkedSnapshot, hubtel_order_id: null, amount_paid: null, amount_after_charges: null }
    const bStore: HubtelTxStore = { ...m.store, findBySession: async () => staleRow }
    expect(await processFulfillment(bStore, { ussd_orders: h }, info({ hubtelOrderId: "O2", amountPaid: 99, amountAfterCharges: 98 })))
      .toBe("duplicate")
    expect(h).not.toHaveBeenCalled()
    expect(m.get()).toMatchObject({
      state: "needs_review", callback_status: "sent", hubtel_order_id: "O1", amount_paid: 11.5, amount_after_charges: 10, paid_at: afterA.paid_at,
    })
  })

  it("a normal duplicate on an already-fulfilled row is NOT logged as an error", async () => {
    const m = memoryStore({ state: "fulfilled" })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await processFulfillment(m.store, { ussd_orders: vi.fn() }, info())).toBe("duplicate")
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })

  // I1: an indeterminate-expiry row (needs_review, paid_at null, callback not_due, no OrderId)
  // that an admin resolved 'fulfilled' ends as fulfilled + paid_at null + not_due + resolved_at.
  // A late Hubtel success must still record the payment and make the callback due.
  const resolvedParked = {
    state: "fulfilled" as const, callback_status: "not_due" as const, paid_at: null, hubtel_order_id: null,
    resolved_at: "2026-10-06T10:00:00.000Z", resolved_by: "admin-1", resolution_note: "Delivered manually",
  }

  it("(I1) late success on a parked row an admin resolved 'fulfilled': payment recorded, state kept, callback pending, handler NOT called", async () => {
    const m = memoryStore(resolvedParked)
    const h = vi.fn()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await processFulfillment(m.store, { ussd_orders: h }, info())).toBe("fulfilled")
    warn.mockRestore()
    expect(h).not.toHaveBeenCalled()
    expect(m.get()).toMatchObject({
      state: "fulfilled", callback_status: "pending", hubtel_order_id: "O1", amount_paid: 11.5, amount_after_charges: 10,
      resolved_at: resolvedParked.resolved_at, resolved_by: "admin-1", resolution_note: "Delivered manually",
    })
    expect(m.get().paid_at).toBeTruthy()
  })

  it("(I1) a normal fulfilled row (no resolved_at) stays duplicate, untouched", async () => {
    const m = memoryStore({ ...resolvedParked, resolved_at: null })
    const h = vi.fn()
    expect(await processFulfillment(m.store, { ussd_orders: h }, info())).toBe("duplicate")
    expect(h).not.toHaveBeenCalled()
    expect(m.get()).toMatchObject({ state: "fulfilled", callback_status: "not_due", hubtel_order_id: null, paid_at: null })
  })

  it("(I1) a resolved fulfilled row that already has paid_at (or a due callback) stays duplicate", async () => {
    for (const over of [
      { paid_at: "2026-10-06T09:00:00.000Z" },
      { callback_status: "pending" as const, hubtel_order_id: "H1" },
    ]) {
      const m = memoryStore({ ...resolvedParked, ...over })
      const before = { ...m.get() }
      expect(await processFulfillment(m.store, { ussd_orders: vi.fn() }, info({ hubtelOrderId: "O2" }))).toBe("duplicate")
      expect(m.get()).toEqual(before)
    }
  })

  it("(I1) an unsuccessful late delivery on a resolved row records nothing", async () => {
    const m = memoryStore(resolvedParked)
    expect(await processFulfillment(m.store, { ussd_orders: vi.fn() }, info({ isSuccessful: false }))).toBe("duplicate")
    expect(m.get()).toMatchObject({ state: "fulfilled", callback_status: "not_due", paid_at: null, hubtel_order_id: null })
  })

  it("(I1) two concurrent late successes on a resolved row: the guarded update is the CAS (one fulfilled, one duplicate)", async () => {
    const m = memoryStore(resolvedParked)
    const h = vi.fn()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const results = await Promise.all([
      processFulfillment(m.store, { ussd_orders: h }, info()),
      processFulfillment(m.store, { ussd_orders: h }, info({ hubtelOrderId: "O2", amountPaid: 99 })),
    ])
    warn.mockRestore()
    expect(results.sort()).toEqual(["duplicate", "fulfilled"])
    expect(h).not.toHaveBeenCalled()
    expect(m.get()).toMatchObject({ state: "fulfilled", callback_status: "pending", hubtel_order_id: "O1", amount_paid: 11.5 })
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
