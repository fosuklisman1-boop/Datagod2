import { notifyRefund, type RefundNotification } from "./notify"

const h = vi.hoisted(() => {
  const calls: any[] = []
  const state = { fail: false }
  // Plain function (not vi.fn) so a deliberately throwing SMS provider is not recorded as a mock failure.
  const sendSMS = async (arg: any) => { calls.push(arg); if (state.fail) throw new Error("sms down") }
  return { calls, state, sendSMS }
})
vi.mock("@/lib/sms-service", () => ({ sendSMS: h.sendSMS }))

const mkDb = (error: any = null) => {
  const insert = vi.fn(async () => ({ error }))
  return { db: { from: vi.fn(() => ({ insert })) } as any, insert }
}
const ev = (payer: string | null = "0241112222", recip: string | null = "0243334444"): RefundNotification => ({
  refundId: "rf1", amount: 9.8, gateway: "paystack",
  order: { id: "o1", packageLabel: "2", network: "MTN", recipientPhone: recip, payment: { payerPhone: payer } } as any,
  clawbacks: [
    { shop_id: "s1", owner_user_id: "u1", from_profit: 3, from_wallet: 1, credited: 3 },
    { shop_id: "s2", owner_user_id: "u2", from_profit: 0, from_wallet: 0, credited: 0 },
    { shop_id: "s3", owner_user_id: null, from_profit: 2, from_wallet: 0, credited: 2 },
  ],
})

beforeEach(() => { h.calls.length = 0; h.state.fail = false })

describe("notifyRefund", () => {
  it("SMS goes to payerPhone", async () => {
    const { db } = mkDb()
    await notifyRefund(db, ev())
    expect(h.calls).toContainEqual(expect.objectContaining({ phone: "0241112222", type: "order_refund", reference: "o1" }))
  })
  it("falls back to recipientPhone", async () => {
    const { db } = mkDb()
    await notifyRefund(db, ev(null))
    expect(h.calls).toContainEqual(expect.objectContaining({ phone: "0243334444" }))
  })
  it("skips SMS when both are null", async () => {
    const { db } = mkDb()
    await notifyRefund(db, ev(null, null))
    expect(h.calls).toEqual([])
  })
  it("notifies only owners with credited > 0 and a user id", async () => {
    const { db, insert } = mkDb()
    await notifyRefund(db, ev())
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: "u1", reference_id: "o1" }))
  })
  it("an SMS failure does not stop owner notifications", async () => {
    h.state.fail = true
    const { db, insert } = mkDb()
    await expect(notifyRefund(db, ev())).resolves.toBeUndefined()
    expect(h.calls).toHaveLength(1)
    expect(insert).toHaveBeenCalledTimes(1)
  })
})
