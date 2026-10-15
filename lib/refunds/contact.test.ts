import { describe, it, expect, vi } from "vitest"
import { loadRefundContact } from "./contact"
import type { RefundableOrder } from "./types"

const order = (o: Partial<RefundableOrder> = {}): RefundableOrder => ({
  table: "shop_orders", id: "o1", orderStatus: "pending", paymentStatus: "completed",
  shopId: "s1", shopName: "Alpha", packageLabel: "2", network: "MTN", recipientPhone: "0243334444",
  createdAt: "2026-10-05", paid: 10, gatewayFee: 0,
  payment: { gateway: "paystack", reference: "r", payerPhone: "0241112222", walletUserId: null },
  owners: [], evidence: { hasActiveRefund: false, dispatchOutcome: null, dispatchAttempts: null, trackingStatuses: [], externalOrderId: null },
  ...o,
})

/** rows[table] is what `.from(table).select().eq().maybeSingle()` resolves to. */
function fakeDb(rows: Record<string, unknown>, error: unknown = null) {
  const eq = vi.fn()
  const from = vi.fn((table: string) => ({
    select: () => ({ eq: (col: string, val: unknown) => { eq(table, col, val); return { maybeSingle: async () => ({ data: rows[table] ?? null, error }) } } }),
  }))
  return { db: { from } as any, from, eq }
}

describe("loadRefundContact", () => {
  it("storefront: shows the customer's name/email, pays the number that PAID (never assumes the data recipient)", async () => {
    const { db } = fakeDb({ shop_orders: { customer_name: "Ama Mensah", customer_email: "ama@x.com", customer_phone: "0243334444" } })
    expect(await loadRefundContact(db, order())).toEqual({
      name: "Ama Mensah", email: "ama@x.com", phone: null, payerPhone: "0241112222", recipientPhone: "0243334444", payTo: "0241112222",
    })
  })
  it("storefront with an unknown payer: payTo is null so the admin must contact the customer first", async () => {
    const { db } = fakeDb({ shop_orders: { customer_name: "Ama", customer_email: null, customer_phone: "0243334444" } })
    const c = await loadRefundContact(db, order({ payment: { gateway: "paystack", reference: "r", payerPhone: null, walletUserId: null } }))
    expect(c?.payTo).toBeNull()
    expect(c?.recipientPhone).toBe("0243334444")
  })
  it("USSD: the dialling number is the customer's own phone and the fallback payout number", async () => {
    const { db } = fakeDb({ ussd_orders: { dialing_phone: "0209998888", recipient_phone: "0243334444" } })
    const c = await loadRefundContact(db, order({ table: "ussd_orders", payment: { gateway: "paystack", reference: "r", payerPhone: null, walletUserId: null } }))
    expect(c).toMatchObject({ phone: "0209998888", recipientPhone: "0243334444", payTo: "0209998888" })
  })
  it("USSD shop: includes the customer email when present", async () => {
    const { db } = fakeDb({ ussd_shop_orders: { dialing_phone: "0209998888", recipient_phone: "0243334444", customer_email: "k@x.com" } })
    expect(await loadRefundContact(db, order({ table: "ussd_shop_orders" }))).toMatchObject({ email: "k@x.com", phone: "0209998888", payTo: "0241112222" })
  })
  it("bulk/API (wallet-paid): the ACCOUNT holder's name, email and phone; pays the account phone", async () => {
    const { db, eq } = fakeDb({ users: { first_name: "Kofi", last_name: "Boateng", email: "kofi@x.com", phone_number: "0551234567", phone: null } })
    const c = await loadRefundContact(db, order({ table: "orders", buyerUserId: "uB", payment: { gateway: "wallet", reference: null, payerPhone: null, walletUserId: "uB" } }))
    expect(eq).toHaveBeenCalledWith("users", "id", "uB")
    expect(c).toEqual({ name: "Kofi Boateng", email: "kofi@x.com", phone: "0551234567", payerPhone: null, recipientPhone: "0243334444", payTo: "0551234567" })
  })
  it("commission orders get no contact card (they use 'Mark refunded manually')", async () => {
    const { db, from } = fakeDb({})
    expect(await loadRefundContact(db, order({ table: "airtime_orders" }))).toBeNull()
    expect(from).not.toHaveBeenCalled()
  })
  it("a lookup error still returns what the order itself knows (never blocks the refund preview)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const { db } = fakeDb({}, { message: "boom" })
    expect(await loadRefundContact(db, order())).toMatchObject({ name: null, payerPhone: "0241112222", payTo: "0241112222" })
    err.mockRestore()
  })
})
