import { describe, expect, it, vi } from "vitest"
import { createBillOrdersAdapter, STOREFRONT_REFUND_MESSAGE, type BillOrderRow } from "./bill-orders"
import { createDataOrdersAdapter, type DataOrderRow } from "./data-orders"
import { createAirtimeOrdersAdapter } from "./airtime-orders"
import { makeTx } from "../testing/fixtures"

// The review queue's refundToWallet credits o.user_id. Storefront rows have user_id NULL: they must be refused (which
// releases the ledger claim) and pointed at /admin/refunds — never "refunded" to a null wallet.

const bill = (o: Partial<BillOrderRow> = {}): BillOrderRow => ({
  status: "failed", payment_status: "paid", user_id: null, channel: "storefront", biller: "ecg", amount: 100, paid_amount: 101.82, account_number: "123456", ...o,
})
const bundle = (o: Partial<DataOrderRow> = {}): DataOrderRow => ({
  status: "failed", payment_status: "paid", user_id: null, channel: "storefront", network: "MTN", bundle_display: "1GB", beneficiary_phone: "233241112222", amount: 12, paid_amount: 12.3, ...o,
})
const spies = () => ({ update: vi.fn(async () => 1), creditWallet: vi.fn(async () => {}), notify: vi.fn(async () => {}), alertAdmin: vi.fn(async () => {}) })

describe("Hubtel review-queue refunds refuse storefront orders", () => {
  it("bills: storefront row (and any row without a user) is refused, nothing credited or flipped", async () => {
    for (const row of [bill(), bill({ channel: "dashboard", user_id: null }), bill({ status: "refunded", payment_status: "refunded" })]) {
      const s = spies()
      const r = await createBillOrdersAdapter({ ...s, get: async () => row }).refundToWallet!(makeTx({ order_id: "o1" }), "admin")
      expect(r).toEqual({ refunded: false, message: STOREFRONT_REFUND_MESSAGE })
      expect(r.message).toContain("/admin/refunds")
      expect(s.creditWallet).not.toHaveBeenCalled()
      expect(s.update).not.toHaveBeenCalled()
    }
  })

  it("bundles: storefront row is refused, nothing credited or flipped", async () => {
    const s = spies()
    const r = await createDataOrdersAdapter({ ...s, get: async () => bundle() }).refundToWallet!(makeTx({ order_id: "o1" }), "admin")
    expect(r).toEqual({ refunded: false, message: STOREFRONT_REFUND_MESSAGE })
    expect(s.creditWallet).not.toHaveBeenCalled()
    expect(s.update).not.toHaveBeenCalled()
  })

  it("dashboard rows still refund to the wallet as before", async () => {
    const s = spies()
    const r = await createBillOrdersAdapter({ ...s, get: async () => bill({ channel: "dashboard", user_id: "u1" }) }).refundToWallet!(makeTx({ order_id: "o1" }), "admin")
    expect(r.refunded).toBe(true)
    expect(s.creditWallet).toHaveBeenCalledWith("u1", 101.82, "bill-refund-o1", expect.any(String))
  })

  it("api rows (wallet-paid by the API key owner) refund to that wallet like dashboard rows", async () => {
    const s = spies()
    const r = await createBillOrdersAdapter({ ...s, get: async () => bill({ channel: "api", user_id: "u1" }) }).refundToWallet!(makeTx({ order_id: "o1" }), "admin")
    expect(r.refunded).toBe(true)
    expect(s.creditWallet).toHaveBeenCalledWith("u1", 101.82, "bill-refund-o1", expect.any(String))

    const s2 = spies()
    const r2 = await createDataOrdersAdapter({ ...s2, get: async () => bundle({ channel: "api", user_id: "u1" }) }).refundToWallet!(makeTx({ order_id: "o1" }), "admin")
    expect(r2.refunded).toBe(true)
    expect(s2.creditWallet).toHaveBeenCalledWith("u1", 12.3, expect.any(String), expect.any(String))
  })

  it("storefront failure/delivery notifications are skipped (no account to notify)", async () => {
    const s = spies()
    await createDataOrdersAdapter({ ...s, get: async () => bundle({ status: "processing" }) }).onFailed(makeTx({ order_id: "o1" }))
    await createBillOrdersAdapter({ ...s, get: async () => bill({ status: "processing" }) }).onFulfilled(makeTx({ order_id: "o1" }))
    expect(s.notify).not.toHaveBeenCalled()
  })

  it("airtime has no review-queue refund handler at all", () => {
    const a = createAirtimeOrdersAdapter({ update: async () => 1, get: async () => null, getStatus: async () => null, alert: async () => {} })
    expect(a.refundToWallet).toBeUndefined()
  })

  it("airtime: Hubtel delivering after a storefront refund raises the double-value alert", async () => {
    const alert = vi.fn(async () => {})
    await createAirtimeOrdersAdapter({ update: async () => 0, get: async () => null, getStatus: async () => "refunded", alert }).onFulfilled(makeTx({ order_id: "o1" }))
    expect(alert).toHaveBeenCalledWith(expect.stringMatching(/double value/))
  })
})
