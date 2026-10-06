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

import { createOrderHandlers, createFailHandlers, OK_FULFILMENT_STATUSES } from "./order-handlers"

/**
 * Table-aware fake. select(...).eq(...).maybeSingle() returns rows[table] (the same object every
 * time, so a mocked library call may mutate it). An update chain ending in .select() only matches
 * when the row's in() column value is in the list, like the real conditional update; an awaited
 * update without .select() always applies. Applied patches are merged into the served row.
 * `updates` holds applied patches in order; `log` also records the table and the in() filter.
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
              if (ok) { updates.push(patch); log.push(rec); Object.assign(row, patch) } // applied to the served row, like the real db
              return { data: ok ? [{ id: row.id }] : [], error: null }
            },
            then: (res: any) => { updates.push(patch); log.push(rec); if (rows[table]) Object.assign(rows[table], patch); return res({ error: null }) },
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
  it("pending own-voucher request → fulfillPaidResultsCheckRequest once, row re-read shows paid", async () => {
    const row: any = { id: "q1", payment_status: "pending_payment", status: "pending", mode: "own_voucher" }
    fulfillPaidResultsCheckRequest.mockImplementation(async () => { row.payment_status = "paid"; return paid })
    const { client } = fakeDb({ results_check_requests: row })
    await createOrderHandlers(client).results_check_requests("q1")
    expect(fulfillPaidResultsCheckRequest).toHaveBeenCalledTimes(1)
    expect(fulfillPaidResultsCheckRequest).toHaveBeenCalledWith("q1")
  })
  it("combo with a voucher assigned → ok", async () => {
    const row: any = { id: "q1", payment_status: "pending_payment", status: "pending", mode: "combo", voucher_pin: null }
    fulfillPaidResultsCheckRequest.mockImplementation(async () => { row.payment_status = "paid"; row.voucher_pin = "123456789012"; return paid })
    const { client } = fakeDb({ results_check_requests: row })
    await createOrderHandlers(client).results_check_requests("q1")
  })
  it("combo paid but no voucher in stock → throws so the row lands in needs_review (review focus #2)", async () => {
    const row: any = { id: "q1", payment_status: "pending_payment", status: "pending", mode: "combo", voucher_pin: null }
    fulfillPaidResultsCheckRequest.mockImplementation(async () => { row.payment_status = "paid"; return paid })
    const { client } = fakeDb({ results_check_requests: row })
    await expect(createOrderHandlers(client).results_check_requests("q1")).rejects.toThrow(/no voucher/)
  })
  for (const mode of ["own_voucher", "combo"]) {
    it(`${mode}: library reports success but the row is still unpaid (swallowed update error) → throws`, async () => {
      fulfillPaidResultsCheckRequest.mockResolvedValue(paid)
      const { client } = fakeDb({ results_check_requests: { id: "q1", payment_status: "pending_payment", status: "pending", mode, voucher_pin: "123456789012" } })
      await expect(createOrderHandlers(client).results_check_requests("q1")).rejects.toThrow(/still pending_payment|not paid/)
    })
  }
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

describe("ussd_afa_orders post-payment handler", () => {
  const base = { id: "a1", dialing_phone: "+233244123456", shop_id: null, fulfillment_status: "unfulfilled" }
  // fulfill-afa.ts records the provider outcome in fulfillment_status; mimic what it leaves behind.
  const leaves = (row: any, status: string, result = { success: true, message: "ok" }) => async () => {
    row.fulfillment_status = status
    return result
  }

  it("failed order (late payment after expiry) → throws, no fulfilment, no SMS (review focus #5)", async () => {
    const { client } = fakeDb({ ussd_afa_orders: { ...base, payment_status: "failed" } })
    await expect(createOrderHandlers(client).ussd_afa_orders("a1")).rejects.toThrow(/not in a payable state: failed/)
    expect(fulfillUssdAfaOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("pending → marked completed (conditional, applied to the row), registration submitted once, payer SMSed", async () => {
    const row = { ...base, payment_status: "pending" }
    fulfillUssdAfaOrder.mockImplementation(leaves(row, "fulfilled"))
    const { client, log } = fakeDb({ ussd_afa_orders: row })
    await createOrderHandlers(client).ussd_afa_orders("a1")
    expect(log[0]).toMatchObject({ table: "ussd_afa_orders", patch: { payment_status: "completed" }, inVals: ["pending"] })
    expect(row.payment_status).toBe("completed")
    expect(fulfillUssdAfaOrder).toHaveBeenCalledTimes(1)
    expect(fulfillUssdAfaOrder).toHaveBeenCalledWith("a1")
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(sendSMS.mock.calls[0][0]).toMatchObject({ phone: "+233244123456", message: "afa-paid" })
  })
  // Success paths of fulfill-afa.ts: Sykes accepted => 'fulfilled'; Apex accepted => 'pending' (sync cron confirms).
  for (const ok of [...OK_FULFILMENT_STATUSES]) {
    it(`fulfillment_status '${ok}' (provider accepted) → payer SMSed exactly once, no throw`, async () => {
      const row = { ...base, payment_status: "pending" }
      fulfillUssdAfaOrder.mockImplementation(leaves(row, ok))
      const { client } = fakeDb({ ussd_afa_orders: row })
      await expect(createOrderHandlers(client).ussd_afa_orders("a1")).resolves.toBeUndefined()
      expect(sendSMS).toHaveBeenCalledTimes(1)
    })
  }
  it("provider failure left fulfillment_status 'failed' → throws naming the status, no SMS (needs_review)", async () => {
    const row = { ...base, payment_status: "pending" }
    fulfillUssdAfaOrder.mockImplementation(leaves(row, "failed", { success: false, message: "provider down" }))
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const { client } = fakeDb({ ussd_afa_orders: row })
    await expect(createOrderHandlers(client).ussd_afa_orders("a1")).rejects.toThrow(/fulfillment_status.*failed/)
    err.mockRestore()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("claim DB error left fulfillment_status 'unfulfilled' → throws, no SMS", async () => {
    fulfillUssdAfaOrder.mockResolvedValue({ success: false, message: "Failed to claim order for fulfillment" })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const { client } = fakeDb({ ussd_afa_orders: { ...base, payment_status: "pending" } })
    await expect(createOrderHandlers(client).ussd_afa_orders("a1")).rejects.toThrow(/fulfillment_status.*unfulfilled/)
    err.mockRestore()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("an unexpected fulfillment_status → throws, no SMS", async () => {
    const row = { ...base, payment_status: "pending" }
    fulfillUssdAfaOrder.mockImplementation(leaves(row, "weird"))
    const { client } = fakeDb({ ussd_afa_orders: row })
    await expect(createOrderHandlers(client).ussd_afa_orders("a1")).rejects.toThrow(/weird/)
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("fulfilment library throws and nothing was submitted → throws, no SMS", async () => {
    fulfillUssdAfaOrder.mockRejectedValue(new Error("boom"))
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const { client } = fakeDb({ ussd_afa_orders: { ...base, payment_status: "pending" } })
    await expect(createOrderHandlers(client).ussd_afa_orders("a1")).rejects.toThrow(/fulfillment_status/)
    err.mockRestore()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("order unreadable after fulfilment → throws, no SMS", async () => {
    const rows: Record<string, any> = { ussd_afa_orders: { ...base, payment_status: "pending" } }
    fulfillUssdAfaOrder.mockImplementation(async () => { delete rows.ussd_afa_orders; return { success: true, message: "ok" } })
    const { client } = fakeDb(rows)
    await expect(createOrderHandlers(client).ussd_afa_orders("a1")).rejects.toThrow(/unreadable/)
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("a shop-scoped AFA row is refused (shop profit is not ported) → throws, nothing marked", async () => {
    const { client, updates } = fakeDb({ ussd_afa_orders: { ...base, shop_id: "s1", payment_status: "pending" } })
    await expect(createOrderHandlers(client).ussd_afa_orders("a1")).rejects.toThrow(/shop-scoped/)
    expect(updates).toHaveLength(0)
    expect(fulfillUssdAfaOrder).not.toHaveBeenCalled()
  })
  it("missing order → throws, nothing fulfilled", async () => {
    const { client } = fakeDb({})
    await expect(createOrderHandlers(client).ussd_afa_orders("a1")).rejects.toThrow(/not found/)
    expect(fulfillUssdAfaOrder).not.toHaveBeenCalled()
  })
  it("lost the conditional mark (the row changed between read and mark) → throws, no fulfilment", async () => {
    // The first read says pending; by the time of the conditional update the row has been failed.
    const row: any = { ...base, payment_status: "pending" }
    const { client } = fakeDb({ ussd_afa_orders: row })
    const realFrom = client.from.bind(client)
    client.from = (t: string) => {
      const q = realFrom(t)
      const upd = q.update
      q.update = (patch: any) => { row.payment_status = "failed"; return upd(patch) }
      return q
    }
    await expect(createOrderHandlers(client).ussd_afa_orders("a1")).rejects.toThrow(/not in a payable state/)
    expect(fulfillUssdAfaOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("already completed → no-op", async () => {
    const { client } = fakeDb({ ussd_afa_orders: { ...base, payment_status: "completed" } })
    await createOrderHandlers(client).ussd_afa_orders("a1")
    expect(fulfillUssdAfaOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("fail handler fails only an unpaid AFA order", async () => {
    const { client, log } = fakeDb({ ussd_afa_orders: { id: "a1", payment_status: "pending" } })
    await createFailHandlers(client).ussd_afa_orders("a1")
    expect(log[0]).toMatchObject({ patch: { order_status: "failed", payment_status: "failed" }, inVals: ["pending"] })
  })
})
