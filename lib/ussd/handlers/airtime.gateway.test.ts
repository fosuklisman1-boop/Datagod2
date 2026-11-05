// Uzo main-menu airtime with the REAL startMomoCharge. Legacy airtime has no Paystack fee (its fee is margin), so it
// charges the same on both gateways. Cashback airtime: payAmount 9.69 = base 9.50 + Paystack fee 0.19; Hubtel 9.50.
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  afterFns: [] as Array<() => Promise<void>>,
  sessions: new Map<string, any>(),
  charge: null as any,
  quote: null as any,
  dialer: {} as any,
  verified: new Set<string>(),
}))
vi.mock("@/lib/whatsapp-bot/cashback-visibility", () => ({ whatsappBotItemsVisible: vi.fn(async () => ({ cashbackAirtime: true })) }))
vi.mock("@/lib/storefront-otp", async (orig) => ({
  ...(await orig<object>()),
  isPhoneOtpVerified: vi.fn(async (p: string) => h.verified.has(p)),
}))

vi.mock("@supabase/supabase-js", async () => (await import("@/lib/ussd/gateway-test-kit")).supabaseMock())
vi.mock("@/lib/payment-gateway/read-config", async () => (await import("@/lib/ussd/gateway-test-kit")).readConfigMock())
vi.mock("@/lib/payment-gateway/hubtel-readiness", async () => (await import("@/lib/ussd/gateway-test-kit")).readinessMock())
vi.mock("@/lib/hubtel-pay/client", async (orig) => (await import("@/lib/ussd/gateway-test-kit")).relayMock(await orig()))
vi.mock("@/lib/hubtel-pay/alert-throttle", async () => (await import("@/lib/ussd/gateway-test-kit")).alertMock())
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => { h.afterFns.push(fn) } }))
vi.mock("@/lib/ussd/session", () => ({ setSession: vi.fn(async (id: string, s: any) => { h.sessions.set(id, s) }) }))
vi.mock("@/lib/ussd/resolve-dialer", () => ({ resolveDialer: vi.fn(async () => ({ ...h.dialer })) }))
vi.mock("@/lib/ussd/resolve-email", () => ({ resolveEmail: vi.fn(async () => "payer@example.com") }))
vi.mock("@/lib/paystack", async (orig) => ({ ...(await orig<object>()), chargeMobileMoney: vi.fn(async (p: any) => h.charge(p)) }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(async () => {}), SMSTemplates: { ussdAirtimePaymentReceived: () => "s", ussdOtpRequired: () => "otp" } }))
vi.mock("@/lib/whatsapp-bot/send", () => ({ sendWhatsAppText: vi.fn(async () => {}) }))
vi.mock("@/lib/secure-random", () => ({ secureReference: () => "AT-REF-001" }))
vi.mock("@/lib/ussd-service-visibility", () => ({ getUssdServiceVisibility: vi.fn(async () => ({ airtime: true, cashbackAirtime: true })) }))
vi.mock("@/lib/cashback/storefront-airtime", () => ({ quoteBotAirtime: vi.fn(async (_n: string, face: number) => (h.quote ? { ...h.quote, faceAmount: face } : null)) }))
vi.mock("@/lib/airtime-pricing", async (orig) => ({
  ...(await orig<object>()),
  isAirtimeEnabled: vi.fn(async () => true),
  getAirtimeLimits: vi.fn(async () => ({ min: 1, max: 500 })),
  airtimeBaseFeeRate: vi.fn(async () => 5),
}))
vi.mock("@/lib/ussd/bots/gate", () => ({ botMenusVisible: async () => ({}), UZO_BOT_MENUS_HIDDEN: {} }))

import { handleAirtimeConfirm, handleAirtimePaymentMethod } from "./airtime"
import { chargeMobileMoney } from "@/lib/paystack"
import { gatewayConfig, hubtelRows, kit, resetKit, rows } from "../gateway-test-kit"

const DIALER = "0241112222"
const QUOTE = {
  applied: true, faceAmount: 10, rate: 10, share: 50, commission: 1, customerCashback: 0.5, shopShare: 0,
  payAmount: 9.69, datagodKeeps: 0.5, provider: "hubtel", base: 9.5, paymentFee: 0.19, feeRate: 1.95,
}
const legacy = (over: any = {}): any => ({
  step: "AIRTIME_CONFIRM", dialingPhone: DIALER, airtimeRecipient: "0201234567", airtimeNetwork: "MTN",
  airtimeAmount: 10.5, airtimeFee: 0.5, airtimeToDeliver: 10, ...over,
})
const cashback = (over: any = {}): any => legacy({ airtimeAmount: 10, airtimeFee: 0, airtimeToDeliver: 10, airtimeCashbackPay: 9.69, ...over })

async function runAfter() {
  const done = Promise.all(h.afterFns.splice(0).map((f) => f()))
  await vi.advanceTimersByTimeAsync(5000)
  await done
}
const order = () => rows("airtime_orders")[0]

beforeEach(() => {
  vi.useFakeTimers()
  resetKit()
  h.afterFns = []
  h.sessions.clear()
  h.quote = null
  h.dialer = {}
  h.verified.clear()
  h.charge = async (p: any) => ({ status: "pay_offline", reference: p.reference })
  vi.mocked(chargeMobileMoney).mockClear()
})

describe("Uzo airtime on Paystack (unchanged)", () => {
  it("legacy: total_paid as typed, today's params, no Hubtel row", async () => {
    await handleAirtimeConfirm("1", "S1", legacy(), "ussd")
    await runAfter()
    expect(order().total_paid).toBe(10.5)
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toEqual({
      email: "payer@example.com", amount: 10.5, phone: DIALER, provider: "mtn", reference: order().id,
      metadata: { source: "ussd_airtime", airtime_order_id: order().id, recipient_phone: "0201234567", network: "MTN" },
    })
    expect(hubtelRows()).toHaveLength(0)
    expect(rows("payment_attempts")[0]).toMatchObject({ amount: 10.5, payment_type: "ussd_airtime" })
  })

  it("cashback: payAmount with the fee, as today", async () => {
    h.quote = QUOTE
    await handleAirtimeConfirm("1", "S1", cashback(), "ussd")
    await runAfter()
    expect(order()).toMatchObject({ total_paid: 9.69, payment_fee_amount: 0.19 })
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBe(9.69)
  })

  it("a Paystack error still fails the order", async () => {
    h.charge = async () => { throw new Error("boom") }
    await handleAirtimeConfirm("1", "S1", legacy(), "ussd")
    await runAfter()
    expect(order()).toMatchObject({ payment_status: "failed", status: "failed" })
  })
})

describe("Uzo airtime on Hubtel", () => {
  beforeEach(() => { kit.config = gatewayConfig(["ussd"]) })

  it("legacy accepted: same amount (no Paystack fee to drop), one prompt to the dialler for another recipient", async () => {
    await handleAirtimeConfirm("1", "S1", legacy(), "ussd")
    await runAfter()
    expect(order().total_paid).toBe(10.5)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(kit.receive.mock.calls[0][0]).toMatchObject({ msisdn: "233241112222", amount: 10.5, channel: "mtn-gh" })
    expect(hubtelRows()[0].internal_reference).toBe(order().id)
    expect(order().payment_status).toBe("pending_payment")
  })

  it("cashback accepted: the order drops the Paystack fee", async () => {
    h.quote = QUOTE
    await handleAirtimeConfirm("1", "S1", cashback(), "ussd")
    expect(order()).toMatchObject({ total_paid: 9.5, payment_fee_amount: 0 })
    await runAfter()
    expect(kit.receive.mock.calls[0][0].amount).toBe(9.5)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("cashback refused: Paystack at payAmount, the order moved back to it first", async () => {
    h.quote = QUOTE
    kit.receive.mockImplementation(async () => ({ kind: "refused", code: "4000", message: "no" }))
    let at: any
    h.charge = async (p: any) => { at = { ...order() }; return { status: "pay_offline", reference: p.reference } }
    await handleAirtimeConfirm("1", "S1", cashback(), "ussd")
    await runAfter()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBe(9.69)
    expect(at).toMatchObject({ total_paid: 9.69, payment_fee_amount: 0.19 })
    expect(rows("payment_attempts")[0].amount).toBe(9.69)
  })

  it("unknown: no failure and no Paystack", async () => {
    kit.receive.mockImplementation(async () => ({ kind: "unknown", code: "timeout", message: "slow" }))
    await handleAirtimeConfirm("1", "S1", legacy(), "ussd")
    await runAfter()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(order().payment_status).toBe("pending_payment")
  })

  it("wallet detour, cashback: MoMo twice sends one Hubtel prompt at the fee-free price", async () => {
    h.quote = QUOTE
    h.dialer = { userId: "u1", balance: 50 }
    await handleAirtimeConfirm("1", "S1", cashback(), "ussd")
    const s = h.sessions.get("S1")
    expect(s).toMatchObject({ step: "AIRTIME_PAYMENT_METHOD", pendingOrderAmount: { orderId: order().id, amount: 9.5 } })
    await handleAirtimePaymentMethod("2", "S1", s, "ussd")
    await runAfter()
    await handleAirtimePaymentMethod("2", "S1", s, "ussd")
    await runAfter()
    expect(kit.receive).toHaveBeenCalledTimes(1)
    expect(kit.receive.mock.calls[0][0].amount).toBe(9.5)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("WhatsApp: a typed number that isn't the sender's stays on Paystack", async () => {
    kit.config = gatewayConfig(["whatsapp"])
    await handleAirtimeConfirm("1", "233201239999", legacy(), "whatsapp")
    await runAfter()
    expect(kit.receive).not.toHaveBeenCalled()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toMatchObject({ phone: DIALER, amount: 10.5 })
  })

  it("WhatsApp: the sender's own number goes to Hubtel on the whatsapp surface", async () => {
    kit.config = gatewayConfig(["whatsapp"])
    await handleAirtimeConfirm("1", "233241112222", legacy(), "whatsapp")
    await runAfter()
    expect(hubtelRows()[0].surface).toBe("whatsapp")
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("WhatsApp cashback: another number, even an OTP-verified one, stays on Paystack at payAmount", async () => {
    kit.config = gatewayConfig(["whatsapp"])
    h.quote = QUOTE
    h.verified.add(DIALER)
    await handleAirtimeConfirm("1", "233201239999", cashback(), "whatsapp")
    expect(order()).toMatchObject({ total_paid: 9.69, payment_fee_amount: 0.19 })
    await runAfter()
    expect(kit.receive).not.toHaveBeenCalled()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toMatchObject({ phone: DIALER, amount: 9.69 })
  })

  it("WhatsApp cashback: the sender's own number goes to Hubtel without the fee", async () => {
    kit.config = gatewayConfig(["whatsapp"])
    h.quote = QUOTE
    await handleAirtimeConfirm("1", "233241112222", cashback(), "whatsapp")
    expect(order()).toMatchObject({ total_paid: 9.5, payment_fee_amount: 0 })
    await runAfter()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(kit.receive.mock.calls[0][0]).toMatchObject({ msisdn: "233241112222", amount: 9.5 })
  })

  it("WhatsApp cashback: an unverified other number stays on Paystack at payAmount", async () => {
    kit.config = gatewayConfig(["whatsapp"])
    h.quote = QUOTE
    await handleAirtimeConfirm("1", "233201239999", cashback(), "whatsapp")
    expect(order()).toMatchObject({ total_paid: 9.69, payment_fee_amount: 0.19 })
    await runAfter()
    expect(kit.receive).not.toHaveBeenCalled()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBe(9.69)
  })

  it("WhatsApp PAYMENT_METHOD: an OTP-verified other number goes to Paystack at payAmount", async () => {
    kit.config = gatewayConfig(["whatsapp"])
    h.quote = QUOTE
    h.verified.add(DIALER)
    h.dialer = { userId: "u1", balance: 50 }
    await handleAirtimeConfirm("1", "233201239999", cashback(), "whatsapp")
    await handleAirtimePaymentMethod("2", "233201239999", h.sessions.get("233201239999"), "whatsapp")
    await runAfter()
    expect(kit.receive).not.toHaveBeenCalled()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBe(9.69)
  })
})
