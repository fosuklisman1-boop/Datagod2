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

describe("results_checker_orders post-payment handler", () => {
  const base = { id: "r1", exam_board: "WASSCE", quantity: 2 }

  it("failed order (late payment after expiry) → throws, no fulfilment (review focus #5)", async () => {
    const { client } = fakeDb({ results_checker_orders: { ...base, status: "failed", payment_status: "failed" } })
    await expect(createOrderHandlers(client).results_checker_orders("r1")).rejects.toThrow(/not in a payable state/)
    expect(fulfillPaidResultsCheckerOrder).not.toHaveBeenCalled()
  })
  it("status failed but payment_status still payable → throws, no mark, no fulfilment", async () => {
    const { client, log } = fakeDb({ results_checker_orders: { ...base, status: "failed", payment_status: "pending_payment" } })
    await expect(createOrderHandlers(client).results_checker_orders("r1")).rejects.toThrow(/not in a payable state/)
    expect(fulfillPaidResultsCheckerOrder).not.toHaveBeenCalled()
    expect(log).toHaveLength(0)
  })
  it("pending_payment → payment marked completed (conditional), then vouchers fulfilled once", async () => {
    fulfillPaidResultsCheckerOrder.mockResolvedValue({ success: true, status: "completed", message: "ok", newlyPaid: true })
    const { client, log } = fakeDb({ results_checker_orders: { ...base, status: "pending_payment", payment_status: "pending_payment" } })
    await createOrderHandlers(client).results_checker_orders("r1")
    expect(log[0]).toMatchObject({ table: "results_checker_orders", patch: { payment_status: "completed" }, inCol: "payment_status" })
    expect(fulfillPaidResultsCheckerOrder).toHaveBeenCalledTimes(1)
    expect(fulfillPaidResultsCheckerOrder).toHaveBeenCalledWith("r1")
  })
  it("paid but out of stock → throws so the row lands in needs_review (review focus #2)", async () => {
    fulfillPaidResultsCheckerOrder.mockResolvedValue({ success: false, status: "pending", message: "Stock exhausted", newlyPaid: true })
    const { client } = fakeDb({ results_checker_orders: { ...base, status: "pending_payment", payment_status: "pending_payment" } })
    await expect(createOrderHandlers(client).results_checker_orders("r1")).rejects.toThrow(/out of stock/)
  })
  it("fulfilment reports failure (not pending) → throws", async () => {
    fulfillPaidResultsCheckerOrder.mockResolvedValue({ success: false, status: "failed", message: "boom", newlyPaid: true })
    const { client } = fakeDb({ results_checker_orders: { ...base, status: "pending_payment", payment_status: "pending_payment" } })
    await expect(createOrderHandlers(client).results_checker_orders("r1")).rejects.toThrow(/fulfilment failed: boom/)
  })
  it("lost the conditional mark (row changed underneath) → throws, no fulfilment", async () => {
    // The lookup sees a payable row, but another writer flips payment_status before our conditional update.
    const rows: any = { results_checker_orders: { ...base, status: "pending_payment", payment_status: "pending_payment" } }
    const { client } = fakeDb(rows)
    const realFrom = client.from.bind(client)
    client.from = (t: string) => {
      const q = realFrom(t)
      const upd = q.update
      q.update = (patch: any) => { rows[t].payment_status = "completed"; return upd(patch) }
      return q
    }
    await expect(createOrderHandlers(client).results_checker_orders("r1")).rejects.toThrow(/lost the mark/)
    expect(fulfillPaidResultsCheckerOrder).not.toHaveBeenCalled()
  })
  it("missing order → throws", async () => {
    const { client } = fakeDb({})
    await expect(createOrderHandlers(client).results_checker_orders("r1")).rejects.toThrow(/not found/)
  })
  it("already completed → no-op", async () => {
    const { client } = fakeDb({ results_checker_orders: { ...base, status: "completed", payment_status: "completed" } })
    await createOrderHandlers(client).results_checker_orders("r1")
    expect(fulfillPaidResultsCheckerOrder).not.toHaveBeenCalled()
  })
  it("fail handler fails only an unpaid RC order", async () => {
    const { client, log } = fakeDb({ results_checker_orders: { id: "r1", payment_status: "pending_payment" } })
    await createFailHandlers(client).results_checker_orders("r1")
    expect(log[0]).toMatchObject({ patch: { status: "failed", payment_status: "failed" }, inVals: ["pending_payment", "otp_required"] })
  })
})

describe("results_check_requests post-payment handler", () => {
  const paid = { success: true, status: "paid", message: "Payment confirmed" }

  it("failed request (late payment after expiry) → throws, never marked paid (review focus #5)", async () => {
    const { client } = fakeDb({ results_check_requests: { id: "q1", payment_status: "failed", status: "failed", mode: "own_voucher" } })
    await expect(createOrderHandlers(client).results_check_requests("q1")).rejects.toThrow(/not in a payable state/)
    expect(fulfillPaidResultsCheckRequest).not.toHaveBeenCalled()
  })
  it("pending own-voucher request → fulfillPaidResultsCheckRequest once", async () => {
    fulfillPaidResultsCheckRequest.mockResolvedValue(paid)
    const { client } = fakeDb({ results_check_requests: { id: "q1", payment_status: "pending_payment", status: "pending", mode: "own_voucher" } })
    await createOrderHandlers(client).results_check_requests("q1")
    expect(fulfillPaidResultsCheckRequest).toHaveBeenCalledTimes(1)
    expect(fulfillPaidResultsCheckRequest).toHaveBeenCalledWith("q1")
  })
  it("combo with a voucher assigned → ok", async () => {
    const row: any = { id: "q1", payment_status: "pending_payment", status: "pending", mode: "combo", voucher_pin: null }
    fulfillPaidResultsCheckRequest.mockImplementation(async () => { row.voucher_pin = "123456789012"; return paid })
    const { client } = fakeDb({ results_check_requests: row })
    await createOrderHandlers(client).results_check_requests("q1")
  })
  it("combo paid but no voucher in stock → throws so the row lands in needs_review (review focus #2)", async () => {
    fulfillPaidResultsCheckRequest.mockResolvedValue(paid)
    const { client } = fakeDb({ results_check_requests: { id: "q1", payment_status: "pending_payment", status: "pending", mode: "combo", voucher_pin: null } })
    await expect(createOrderHandlers(client).results_check_requests("q1")).rejects.toThrow(/no voucher/)
  })
  it("already paid → no-op", async () => {
    const { client } = fakeDb({ results_check_requests: { id: "q1", payment_status: "paid", status: "pending", mode: "own_voucher" } })
    await createOrderHandlers(client).results_check_requests("q1")
    expect(fulfillPaidResultsCheckRequest).not.toHaveBeenCalled()
  })
  it("library reports not_found → throws", async () => {
    fulfillPaidResultsCheckRequest.mockResolvedValue({ success: false, status: "not_found", message: "Results check request not found" })
    const { client } = fakeDb({ results_check_requests: { id: "q1", payment_status: "pending_payment", status: "pending", mode: "own_voucher" } })
    await expect(createOrderHandlers(client).results_check_requests("q1")).rejects.toThrow(/not marked paid/)
  })
  it("missing request → throws, nothing fulfilled", async () => {
    const { client } = fakeDb({})
    await expect(createOrderHandlers(client).results_check_requests("q1")).rejects.toThrow(/not found/)
    expect(fulfillPaidResultsCheckRequest).not.toHaveBeenCalled()
  })
  it("fail handler fails only an unpaid request", async () => {
    const { client, log } = fakeDb({ results_check_requests: { id: "q1", payment_status: "pending_payment" } })
    await createFailHandlers(client).results_check_requests("q1")
    expect(log[0]).toMatchObject({ patch: { status: "failed", payment_status: "failed" }, inVals: ["pending_payment", "otp_required"] })
  })
})
