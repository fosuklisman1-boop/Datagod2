// lib/ussd-hubtel/order-handlers.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const fulfillUssdOrder = vi.fn()
const sendSMS = vi.fn()
const markAirtimeOrderPaid = vi.fn()
const fulfillPaidResultsCheckerOrder = vi.fn()
const fulfillPaidResultsCheckRequest = vi.fn()
const fulfillUssdAfaOrder = vi.fn()
vi.mock("@/lib/ussd/fulfill", () => ({ fulfillUssdOrder: (...a: any[]) => fulfillUssdOrder(...a) }))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: (...a: any[]) => sendSMS(...a),
  SMSTemplates: {
    ussdOrderConfirmed: () => "confirmed",
    ussdPaymentConfirmed: () => "paid",
    ussdAirtimePaymentReceived: () => "airtime-paid",
    ussdAfaPaymentReceived: () => "afa-paid",
  },
}))
vi.mock("@/lib/app-settings", () => ({ getJoinCommunityLink: async () => "link" }))
vi.mock("@/lib/airtime-service", () => ({ markAirtimeOrderPaid: (...a: any[]) => markAirtimeOrderPaid(...a) }))
vi.mock("@/lib/results-checker-service", () => ({
  fulfillPaidResultsCheckerOrder: (...a: any[]) => fulfillPaidResultsCheckerOrder(...a),
  fulfillPaidResultsCheckRequest: (...a: any[]) => fulfillPaidResultsCheckRequest(...a),
}))
vi.mock("@/lib/ussd/fulfill-afa", () => ({ fulfillUssdAfaOrder: (...a: any[]) => fulfillUssdAfaOrder(...a) }))

import { createOrderHandlers, createFailHandlers } from "./order-handlers"

/**
 * Table-aware fake. select(...).eq(...).maybeSingle() returns rows[table] (the same object every
 * time, so a mocked library call may mutate it). An update chain ending in .select() only matches
 * when the row's in() column value is in the list, like the real conditional update; an awaited
 * update without .select() always applies. `updates` holds applied patches in order; `log` also
 * records the table and the in() filter.
 */
function fakeDb(rows: Record<string, any>) {
  const updates: any[] = []
  const log: Array<{ table: string; patch: any; inCol?: string; inVals?: string[] }> = []
  const client = {
    from(table: string) {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: rows[table] ?? null, error: null }) }) }),
        update: (patch: any) => {
          const rec: { table: string; patch: any; inCol?: string; inVals?: string[] } = { table, patch }
          const chain: any = {
            eq: () => chain,
            in: (col: string, vals: string[]) => { rec.inCol = col; rec.inVals = vals; return chain },
            select: async () => {
              const row = rows[table]
              const ok = !!row && (!rec.inCol || (rec.inVals ?? []).includes(row[rec.inCol]))
              if (ok) { updates.push(patch); log.push(rec) }
              return { data: ok ? [{ id: row.id }] : [], error: null }
            },
            then: (res: any) => { updates.push(patch); log.push(rec); return res({ error: null }) },
          }
          return chain
        },
        insert: async () => ({ error: null }),
      }
    },
  }
  return { client: client as any, updates, log }
}
const fakeSupabase = (order: any) => fakeDb({ ussd_orders: order })

beforeEach(() => {
  for (const m of [fulfillUssdOrder, sendSMS, markAirtimeOrderPaid, fulfillPaidResultsCheckerOrder, fulfillPaidResultsCheckRequest, fulfillUssdAfaOrder]) m.mockReset()
  fulfillUssdOrder.mockResolvedValue({ success: true, message: "ok" })
  markAirtimeOrderPaid.mockResolvedValue({ success: true })
})

const baseOrder = {
  id: "o1", network: "MTN", recipient_phone: "0241234567", dialing_phone: "0241234567",
  package_size: "1", parent_shop_id: null, parent_profit_amount: 0,
}

describe("ussd_orders post-payment handler", () => {
  it("failed order → throws, no fulfilment, no SMS", async () => {
    const { client } = fakeSupabase({ ...baseOrder, payment_status: "failed" })
    await expect(createOrderHandlers(client).ussd_orders("o1")).rejects.toThrow(/not in a payable state: failed/)
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it("pending order → marks completed, fulfils once, SMSes recipient", async () => {
    const { client, updates } = fakeSupabase({ ...baseOrder, payment_status: "pending" })
    await createOrderHandlers(client).ussd_orders("o1")
    expect(updates[0]).toMatchObject({ payment_status: "completed" })
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(sendSMS.mock.calls[0][0].phone).toBe("0241234567")
  })

  it("already completed → returns without fulfilling", async () => {
    const { client } = fakeSupabase({ ...baseOrder, payment_status: "completed" })
    await createOrderHandlers(client).ussd_orders("o1")
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
})

describe("airtime_orders post-payment handler", () => {
  const base = { id: "t1", network: "MTN", beneficiary_phone: "0244123456", dialing_phone: "+233200585542", airtime_amount: 9.52 }

  it("failed order (late payment after expiry) → throws, never marked paid, no SMS (review focus #5)", async () => {
    const { client } = fakeDb({ airtime_orders: { ...base, payment_status: "failed" } })
    await expect(createOrderHandlers(client).airtime_orders("t1")).rejects.toThrow(/not in a payable state: failed/)
    expect(markAirtimeOrderPaid).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("pending_payment → markAirtimeOrderPaid once, SMS to the recipient and to a different payer", async () => {
    const { client } = fakeDb({ airtime_orders: { ...base, payment_status: "pending_payment" } })
    await createOrderHandlers(client).airtime_orders("t1")
    expect(markAirtimeOrderPaid).toHaveBeenCalledTimes(1)
    expect(markAirtimeOrderPaid).toHaveBeenCalledWith("t1", null)
    expect(sendSMS.mock.calls.map(c => c[0].phone)).toEqual(["0244123456", "+233200585542"])
    expect(sendSMS.mock.calls[0][0].message).toBe("airtime-paid")
  })
  it("payer is the recipient → one SMS", async () => {
    const { client } = fakeDb({ airtime_orders: { ...base, dialing_phone: "+233244123456", payment_status: "pending_payment" } })
    await createOrderHandlers(client).airtime_orders("t1")
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })
  it("already completed → no-op", async () => {
    const { client } = fakeDb({ airtime_orders: { ...base, payment_status: "completed" } })
    await createOrderHandlers(client).airtime_orders("t1")
    expect(markAirtimeOrderPaid).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("markAirtimeOrderPaid says alreadyProcessed → no SMS", async () => {
    markAirtimeOrderPaid.mockResolvedValue({ success: true, alreadyProcessed: true })
    const { client } = fakeDb({ airtime_orders: { ...base, payment_status: "pending_payment" } })
    await createOrderHandlers(client).airtime_orders("t1")
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("markAirtimeOrderPaid fails → throws (needs_review), no SMS", async () => {
    markAirtimeOrderPaid.mockResolvedValue({ success: false })
    const { client } = fakeDb({ airtime_orders: { ...base, payment_status: "pending_payment" } })
    await expect(createOrderHandlers(client).airtime_orders("t1")).rejects.toThrow(/could not be marked paid/)
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("missing order → throws", async () => {
    const { client } = fakeDb({})
    await expect(createOrderHandlers(client).airtime_orders("t1")).rejects.toThrow(/not found/)
  })
})

describe("fail handlers only touch unpaid orders (review focus #5)", () => {
  it("ussd_orders", async () => {
    const { client, log } = fakeDb({ ussd_orders: { id: "o1", payment_status: "pending" } })
    await createFailHandlers(client).ussd_orders("o1")
    expect(log[0]).toMatchObject({ table: "ussd_orders", patch: { order_status: "failed", payment_status: "failed" }, inCol: "payment_status", inVals: ["pending", "otp_required"] })
  })
  it("airtime_orders", async () => {
    const { client, log } = fakeDb({ airtime_orders: { id: "t1", payment_status: "pending_payment" } })
    await createFailHandlers(client).airtime_orders("t1")
    expect(log[0]).toMatchObject({ table: "airtime_orders", patch: { status: "failed", payment_status: "failed" }, inCol: "payment_status", inVals: ["pending_payment", "otp_required"] })
  })
})
