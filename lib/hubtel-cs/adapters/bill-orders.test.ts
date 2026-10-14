import { describe, expect, it, vi } from "vitest"
import { BILL_ORDERS_TABLE, createBillOrdersAdapter } from "./bill-orders"
import { makeTx } from "../testing/fixtures"

const LIVE = ["pending", "processing"]
const order = (o: Partial<{ status: string; payment_status: string; amount: number; paid_amount: number | null }> = {}) => ({
  status: "failed", payment_status: "paid", user_id: "u1", biller: "ecg", amount: 50, account_number: "123456", ...o,
})
const base = () => ({
  get: async () => order({ status: "processing" }) as ReturnType<typeof order> | null,
  update: async () => 1,
  creditWallet: async () => {},
  notify: async () => {},
  alertAdmin: async () => {},
})

describe("hubtel_bill_orders adapter", () => {
  it("owns hubtel_bill_orders", () => {
    expect(createBillOrdersAdapter(base()).table).toBe(BILL_ORDERS_TABLE)
  })
  it("fulfilled from processing -> completed with commission + hcsRef, notifies once", async () => {
    const update = vi.fn(async () => 1), notify = vi.fn(async () => {})
    await createBillOrdersAdapter({ ...base(), update, notify })
      .onFulfilled(makeTx({ order_id: "o1", client_reference: "HCS-1", commission: 0.5 }))
    expect(update).toHaveBeenCalledWith("o1", { status: "completed", commission: 0.5, notes: expect.stringContaining("hcsRef:HCS-1") }, LIVE)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith("u1", "Bill paid", expect.stringContaining("ECG Prepaid & Postpaid GHS 50.00 to 123456 was delivered"), "o1")
  })
  it("fulfilled on refunded order: 0 rows, no notify, admin double-value alert, order untouched", async () => {
    const notify = vi.fn(async () => {}), alertAdmin = vi.fn(async () => {}), update = vi.fn(async () => 0)
    await createBillOrdersAdapter({ ...base(), update, notify, alertAdmin, get: async () => order({ status: "refunded" }) })
      .onFulfilled(makeTx({ order_id: "o1", client_reference: "HCS-1" }))
    expect(notify).not.toHaveBeenCalled()
    expect(alertAdmin).toHaveBeenCalledWith(expect.stringMatching(/HCS-1.*double value/))
    expect(update).toHaveBeenCalledTimes(1)
  })
  it("fulfilled while a storefront refund is in flight ('refunding') also alerts", async () => {
    const alertAdmin = vi.fn(async () => {})
    await createBillOrdersAdapter({ ...base(), update: async () => 0, alertAdmin, get: async () => order({ status: "refunding" }) })
      .onFulfilled(makeTx({ order_id: "o1", client_reference: "HCS-9" }))
    expect(alertAdmin).toHaveBeenCalledWith(expect.stringMatching(/HCS-9.*refunding.*double value/))
  })
  it("fulfilled on failed order also alerts", async () => {
    const alertAdmin = vi.fn(async () => {})
    await createBillOrdersAdapter({ ...base(), update: async () => 0, alertAdmin, get: async () => order({ status: "failed" }) })
      .onFulfilled(makeTx({ order_id: "o1" }))
    expect(alertAdmin).toHaveBeenCalledTimes(1)
  })
  it("fulfilled replay on completed: no notify, no alert", async () => {
    const notify = vi.fn(async () => {}), alertAdmin = vi.fn(async () => {})
    await createBillOrdersAdapter({ ...base(), update: async () => 0, notify, alertAdmin, get: async () => order({ status: "completed" }) })
      .onFulfilled(makeTx({ order_id: "o1" }))
    expect(notify).not.toHaveBeenCalled()
    expect(alertAdmin).not.toHaveBeenCalled()
  })
  it("failed from pending -> failed with reason, notifies", async () => {
    const update = vi.fn(async () => 1), notify = vi.fn(async () => {})
    await createBillOrdersAdapter({ ...base(), update, notify })
      .onFailed(makeTx({ order_id: "o1", failure_reason: "Invalid account" }))
    expect(update).toHaveBeenCalledWith("o1", { status: "failed", failure_reason: "Invalid account", notes: expect.stringMatching(/^Failed via Hubtel/) }, LIVE)
    expect(notify).toHaveBeenCalledWith("u1", "Bill payment failed", expect.stringContaining("under review"), "o1")
  })
  it("failed with 0 rows: no notify", async () => {
    const notify = vi.fn(async () => {})
    await createBillOrdersAdapter({ ...base(), update: async () => 0, notify }).onFailed(makeTx({ order_id: "o1" }))
    expect(notify).not.toHaveBeenCalled()
  })
  it("notify and alert failures never throw out of the hooks", async () => {
    const a = createBillOrdersAdapter({ ...base(), notify: async () => { throw new Error("n") } })
    await expect(a.onFulfilled(makeTx({ order_id: "o1" }))).resolves.toBeUndefined()
    await expect(a.onFailed(makeTx({ order_id: "o1" }))).resolves.toBeUndefined()
    const b = createBillOrdersAdapter({ ...base(), update: async () => 0, get: async () => order({ status: "refunded" }), alertAdmin: async () => { throw new Error("a") } })
    await expect(b.onFulfilled(makeTx({ order_id: "o1" }))).resolves.toBeUndefined()
  })
  it("update errors propagate", async () => {
    const a = createBillOrdersAdapter({ ...base(), update: async () => { throw new Error("db") } })
    await expect(a.onFulfilled(makeTx({ order_id: "o1" }))).rejects.toThrow("db")
    await expect(a.onFailed(makeTx({ order_id: "o1" }))).rejects.toThrow("db")
  })
  it("refund on failed+paid: credits with idempotent reference then marks refunded, notifies", async () => {
    const calls: string[] = []
    const creditWallet = vi.fn(async () => { calls.push("credit") })
    const update = vi.fn(async () => { calls.push("update"); return 1 })
    const notify = vi.fn(async () => {})
    const r = await createBillOrdersAdapter({ ...base(), creditWallet, update, notify, get: async () => order() })
      .refundToWallet!(makeTx({ order_id: "o1", client_reference: "HCS-1" }), "admin")
    expect(r.refunded).toBe(true)
    expect(creditWallet).toHaveBeenCalledWith("u1", 50, "bill-refund-o1", expect.stringContaining("HCS-1"))
    expect(update).toHaveBeenCalledWith("o1", { status: "refunded", payment_status: "refunded" }, ["failed"])
    expect(calls).toEqual(["credit", "update"])
    expect(notify).toHaveBeenCalledWith("u1", "Bill refunded", expect.any(String), "o1")
  })
  it("refund on completed order: refunded:false, no credit", async () => {
    const creditWallet = vi.fn(async () => {})
    const r = await createBillOrdersAdapter({ ...base(), creditWallet, get: async () => order({ status: "completed" }) })
      .refundToWallet!(makeTx({ order_id: "o1" }), "admin")
    expect(r.refunded).toBe(false)
    expect(creditWallet).not.toHaveBeenCalled()
  })
  it("refund on missing order: refunded:false", async () => {
    const r = await createBillOrdersAdapter({ ...base(), get: async () => null }).refundToWallet!(makeTx({ order_id: "o1" }), "a")
    expect(r.refunded).toBe(false)
  })
  it("refund on already refunded order: refunded:true (credit was made), no new credit", async () => {
    const creditWallet = vi.fn(async () => {})
    const r = await createBillOrdersAdapter({ ...base(), creditWallet, get: async () => order({ status: "refunded", payment_status: "refunded" }) })
      .refundToWallet!(makeTx({ order_id: "o1" }), "a")
    expect(r.refunded).toBe(true)
    expect(creditWallet).not.toHaveBeenCalled()
  })
  it("refund: status update matching 0 rows after credit does not throw; returns refunded:true", async () => {
    const r = await createBillOrdersAdapter({ ...base(), update: async () => 0, get: async () => order() })
      .refundToWallet!(makeTx({ order_id: "o1" }), "a")
    expect(r.refunded).toBe(true)
    expect(r.message).toMatch(/status update was skipped/)
  })
  it("refund: credit error propagates and nothing else happens", async () => {
    const update = vi.fn(async () => 1)
    const a = createBillOrdersAdapter({ ...base(), update, creditWallet: async () => { throw new Error("rpc") }, get: async () => order() })
    await expect(a.refundToWallet!(makeTx({ order_id: "o1" }), "a")).rejects.toThrow("rpc")
    expect(update).not.toHaveBeenCalled()
  })
  it("refund: update error propagates", async () => {
    const a = createBillOrdersAdapter({ ...base(), update: async () => { throw new Error("db") }, get: async () => order() })
    await expect(a.refundToWallet!(makeTx({ order_id: "o1" }), "a")).rejects.toThrow("db")
  })
  it("refund returns paid_amount (cashback order), credit and message", async () => {
    const creditWallet = vi.fn(async () => {}), notify = vi.fn(async () => {})
    await createBillOrdersAdapter({ ...base(), creditWallet, notify, get: async () => order({ amount: 10, paid_amount: 9.81 }) })
      .refundToWallet!(makeTx({ order_id: "o1", client_reference: "HCS-1" }), "a")
    expect(creditWallet).toHaveBeenCalledWith("u1", 9.81, "bill-refund-o1", expect.any(String))
    expect(notify).toHaveBeenCalledWith("u1", "Bill refunded", expect.stringContaining("GHS 9.81 for"), "o1")
  })
  it("refund with null paid_amount (legacy) returns amount", async () => {
    const creditWallet = vi.fn(async () => {}), notify = vi.fn(async () => {})
    await createBillOrdersAdapter({ ...base(), creditWallet, notify, get: async () => order({ amount: 10, paid_amount: null }) })
      .refundToWallet!(makeTx({ order_id: "o1", client_reference: "HCS-1" }), "a")
    expect(creditWallet).toHaveBeenCalledWith("u1", 10, "bill-refund-o1", expect.any(String))
    expect(notify).toHaveBeenCalledWith("u1", "Bill refunded", expect.stringContaining("GHS 10.00 for"), "o1")
  })
})
