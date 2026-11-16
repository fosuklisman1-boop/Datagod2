// Airtime confirm per channel. The ussd and whatsapp blocks are CHARACTERISATION tests, written against the code before
// the sms channel existed: they pin what the live bots do today. The sms block covers the text-to-buy channel.
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  afterFns: [] as Array<() => Promise<void>>,
  charge: null as any,
  quote: null as any,
  dialer: {} as any,
  limits: { min: 1, max: 500 },
  enabled: true,
}))

vi.mock("@/lib/whatsapp-bot/cashback-visibility", () => ({ whatsappBotItemsVisible: vi.fn(async () => ({ cashbackAirtime: true })) }))
vi.mock("@/lib/storefront-otp", async (orig) => ({ ...(await orig<object>()), isPhoneOtpVerified: vi.fn(async () => false) }))
vi.mock("@supabase/supabase-js", async () => (await import("@/lib/ussd/gateway-test-kit")).supabaseMock())
vi.mock("@/lib/payment-gateway/read-config", async () => (await import("@/lib/ussd/gateway-test-kit")).readConfigMock())
vi.mock("@/lib/payment-gateway/hubtel-readiness", async () => (await import("@/lib/ussd/gateway-test-kit")).readinessMock())
vi.mock("@/lib/hubtel-pay/client", async (orig) => (await import("@/lib/ussd/gateway-test-kit")).relayMock(await orig()))
vi.mock("@/lib/hubtel-pay/alert-throttle", async () => (await import("@/lib/ussd/gateway-test-kit")).alertMock())
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => { h.afterFns.push(fn) } }))
vi.mock("../session", () => ({ setSession: vi.fn(async () => {}) }))
vi.mock("../resolve-dialer", () => ({ resolveDialer: vi.fn(async () => ({ ...h.dialer })) }))
vi.mock("../resolve-email", () => ({ resolveEmail: vi.fn(async () => "payer@example.com") }))
vi.mock("../wallet-balance", () => ({ liveWalletBalance: vi.fn(async () => undefined) }))
vi.mock("@/lib/paystack", async (orig) => ({ ...(await orig<object>()), chargeMobileMoney: vi.fn(async (p: any) => h.charge(p)) }))
vi.mock("../../sms-service", () => ({
  sendSMS: vi.fn(async () => {}),
  SMSTemplates: { ussdAirtimePaymentReceived: () => "s", ussdOtpRequired: () => "otp" },
}))
vi.mock("../../whatsapp-bot/send", () => ({ sendWhatsAppText: vi.fn(async () => {}) }))
vi.mock("../../whatsapp-bot/session", () => ({ setWaSession: vi.fn(async () => {}) }))
vi.mock("../../secure-random", () => ({ secureReference: () => "AT-REF-001" }))
vi.mock("../../ussd-service-visibility", () => ({ getUssdServiceVisibility: vi.fn(async () => ({ airtime: true, cashbackAirtime: true })) }))
vi.mock("@/lib/cashback/storefront-airtime", () => ({ quoteBotAirtime: vi.fn(async (_n: string, face: number) => (h.quote ? { ...h.quote, faceAmount: face } : null)) }))
vi.mock("../../airtime-pricing", async (orig) => ({
  ...(await orig<object>()),
  isAirtimeEnabled: vi.fn(async () => h.enabled),
  getAirtimeLimits: vi.fn(async () => h.limits),
  airtimeBaseFeeRate: vi.fn(async (_n: string, dealer: boolean) => (dealer ? 2 : 5)),
}))
vi.mock("../bots/gate", () => ({ botMenusVisible: async () => ({}), UZO_BOT_MENUS_HIDDEN: {} }))
// Every export of the bot airtime module is wrapped in a spy that still runs the real function.
vi.mock("../bots/airtime", async (orig) => {
  const real = await orig<Record<string, unknown>>()
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(real)) out[k] = typeof v === "function" ? vi.fn(v as (...a: unknown[]) => unknown) : v
  return out
})

import { confirmAirtimeByText, handleAirtimeConfirm } from "./airtime"
import * as bots from "../bots/airtime"
import { chargeMobileMoney } from "@/lib/paystack"
import { sendSMS } from "../../sms-service"
import { sendWhatsAppText } from "../../whatsapp-bot/send"
import { setWaSession } from "../../whatsapp-bot/session"
import { setSession } from "../session"
import { resolveDialer } from "../resolve-dialer"
import { gatewayConfig, hubtelRows, kit, resetKit, rows } from "../gateway-test-kit"

const DIAL = "+233200000101"
const QUOTE = {
  applied: true, faceAmount: 10, rate: 10, share: 50, commission: 1, customerCashback: 0.5, shopShare: 0,
  payAmount: 9.69, datagodKeeps: 0.5, provider: "hubtel", base: 9.5, paymentFee: 0.19, feeRate: 1.95,
}
const FUNDED = { userId: "u1", balance: 50, email: "dialer@example.com" }
const s = (over: Record<string, unknown> = {}): any => ({
  step: "AIRTIME_CONFIRM", dialingPhone: DIAL, airtimeRecipient: "0241234567", airtimeNetwork: "MTN",
  airtimeAmount: 10.5, airtimeFee: 0.5, airtimeToDeliver: 10, ...over,
})
const order = () => rows("airtime_orders")[0]

async function launch(): Promise<{ done: Promise<unknown> }> {
  const fns = h.afterFns.splice(0)
  const done = Promise.all(fns.map((f) => f()))
  await vi.advanceTimersByTimeAsync(0)
  return { done }
}
/** Starts the captured after() callbacks and waits for them WITHOUT advancing timers: hangs if a wait remains. */
async function runNoWait() {
  const { done } = await launch()
  await done
}
async function runAfter() {
  const { done } = await launch()
  await vi.advanceTimersByTimeAsync(5000)
  await done
}

beforeEach(() => {
  vi.useFakeTimers()
  resetKit()
  kit.config = gatewayConfig()
  kit.config.surfaces.sms_order = { gateway: "paystack", mode: "direct", feeBearer: "customer" }
  h.afterFns = []
  h.quote = null
  h.dialer = {}
  h.limits = { min: 1, max: 500 }
  h.enabled = true
  h.charge = async (p: any) => ({ status: "pay_offline", reference: p.reference })
  for (const m of [chargeMobileMoney, sendSMS, sendWhatsAppText, setWaSession, setSession, resolveDialer]) vi.mocked(m as any).mockClear()
  for (const v of Object.values(bots)) if (typeof v === "function" && "mockClear" in v) (v as any).mockClear()
})

const EXPECTED_ROW = {
  reference_code: "AT-REF-001", network: "MTN", beneficiary_phone: "0241234567", airtime_amount: 10, fee_amount: 0.5,
  total_paid: 10.5, pay_separately: false, status: "pending_payment", payment_status: "pending_payment", shop_id: null,
  merchant_commission: 0, customer_name: "USSD Customer", dialing_phone: DIAL, channel: "ussd",
}
const ussdSession = () => s()
const SESSION_FOR = { ussd: ["S1", ussdSession] as const, whatsapp: ["233200000101", ussdSession] as const }

describe.each(["ussd", "whatsapp"] as const)("characterisation: %s is unchanged", (channel) => {
  const [sid] = SESSION_FOR[channel]

  it("not wallet-eligible: row, end message, one setSession, charge only after the 3 s wait", async () => {
    const r = await handleAirtimeConfirm("1", sid, s(), channel)
    expect(r).toEqual({
      message: "MoMo prompt sent to 0200000101. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.",
      ussdServiceOp: 17,
    })
    expect(order()).toEqual({ id: expect.any(String), created_at: expect.any(String), ...EXPECTED_ROW, user_id: null, customer_email: null })
    expect(vi.mocked(setSession).mock.calls).toEqual([
      [sid, { ...s(), airtimeFee: 0.5, airtimeToDeliver: 10, pendingOrderId: order().id, pendingOrderTable: "airtime_orders" }],
      [sid, { step: "MAIN", dialingPhone: DIAL }],
    ])
    const { done } = await launch()
    await vi.advanceTimersByTimeAsync(2999)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toMatchObject({
      phone: DIAL, provider: "vod", amount: 10.5, metadata: { source: "ussd_airtime", airtime_order_id: order().id },
    })
    expect(rows("payment_attempts")[0]).toMatchObject({ payment_type: "ussd_airtime", amount: 10.5 })
    expect(hubtelRows()).toHaveLength(0)
  })

  it("funded registered dialer: AIRTIME_PAYMENT_METHOD menu, pinned order, no charge", async () => {
    h.dialer = FUNDED
    const r = await handleAirtimeConfirm("1", sid, s(), channel)
    expect(r.message).toContain("GHS 50.00")
    expect(r.ussdServiceOp).toBe(2)
    expect(order()).toEqual({ id: expect.any(String), created_at: expect.any(String), ...EXPECTED_ROW, user_id: "u1", customer_email: "dialer@example.com" })
    expect(vi.mocked(setSession).mock.calls).toEqual([
      [sid, {
        ...s(), step: "AIRTIME_PAYMENT_METHOD", airtimeFee: 0.5, airtimeToDeliver: 10, userId: "u1", walletBalance: 50,
        pendingOrderId: order().id, pendingOrderTable: "airtime_orders",
      }],
    ])
    expect(h.afterFns).toHaveLength(0)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("send_otp: otp_required and the channel's own follow-up", async () => {
    h.charge = async (p: any) => ({ status: "send_otp", reference: p.reference })
    await handleAirtimeConfirm("1", sid, s(), channel)
    await runAfter()
    expect(order().payment_status).toBe("otp_required")
    if (channel === "ussd") {
      expect(sendSMS).toHaveBeenCalledWith({ phone: DIAL, message: "otp", type: "otp_required", reference: order().id })
      expect(setWaSession).not.toHaveBeenCalled()
      expect(sendWhatsAppText).not.toHaveBeenCalled()
    } else {
      expect(setWaSession).toHaveBeenCalledWith(sid, {
        step: "SUBMIT_OTP", dialingPhone: DIAL, pendingOrderId: order().id, pendingOrderTable: "airtime_orders",
      })
      expect(sendWhatsAppText).toHaveBeenCalledTimes(1)
      expect(sendSMS).not.toHaveBeenCalled()
    }
  })
})

describe("sms channel (text-to-buy)", () => {
  const SENDER = "sms:m1"
  const sms = (over: Record<string, unknown> = {}) => s({ airtimeAmount: 10, airtimeFee: undefined, airtimeToDeliver: undefined, ...over })

  it("returns orderId, amount = total_paid and delivers = airtime_amount", async () => {
    const r = await confirmAirtimeByText(SENDER, sms())
    expect(r.orderId).toBe(order().id)
    expect(r.amount).toBe(order().total_paid)
    expect(r.delivers).toBe(order().airtime_amount)
    expect(order()).toMatchObject({ total_paid: 10, airtime_amount: 9.52, fee_amount: 0.48, channel: "ussd", dialing_phone: DIAL })
  })

  it("keeps the row's source columns: payment_type and metadata.source stay ussd_airtime", async () => {
    await confirmAirtimeByText(SENDER, sms())
    await runNoWait()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].metadata).toMatchObject({ source: "ussd_airtime", airtime_order_id: order().id })
    expect(rows("payment_attempts")[0]).toMatchObject({ payment_type: "ussd_airtime" })
  })

  it("a funded registered sender gets no wallet detour: charge started, no payment-method step", async () => {
    h.dialer = FUNDED
    const r = await confirmAirtimeByText(SENDER, sms())
    expect(r.orderId).toBe(order().id)
    expect(r.message).not.toContain("GHS 50.00")
    expect(h.afterFns).toHaveLength(1)
    await runNoWait()
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
  })

  it("charges on sms_order with no wait (runNoWait) and never calls setSession; the sender pays", async () => {
    await confirmAirtimeByText(SENDER, sms())
    await runNoWait() // timers NOT advanced
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
    const call = vi.mocked(chargeMobileMoney).mock.calls[0][0]
    expect(call.phone).toBe(DIAL)
    expect(call.phone).not.toBe("0241234567")
    expect(call.amount).toBe(order().total_paid)
    expect(setSession).not.toHaveBeenCalled()
    expect(hubtelRows()).toHaveLength(0)
  })

  it("send_otp: payment_status otp_required, no sendSMS, no sendWhatsAppText, no setWaSession", async () => {
    h.charge = async (p: any) => ({ status: "send_otp", reference: p.reference })
    await confirmAirtimeByText(SENDER, sms())
    await runNoWait()
    expect(order().payment_status).toBe("otp_required")
    expect(sendSMS).not.toHaveBeenCalled()
    expect(sendWhatsAppText).not.toHaveBeenCalled()
    expect(setWaSession).not.toHaveBeenCalled()
    expect(setSession).not.toHaveBeenCalled()
  })

  it("charge throws: status and payment_status failed", async () => {
    h.charge = async () => { throw new Error("boom") }
    await confirmAirtimeByText(SENDER, sms())
    await runNoWait()
    expect(order()).toMatchObject({ status: "failed", payment_status: "failed" })
  })

  it("airtimeCashbackPay on the session is ignored: legacy pricing, no re-quote, no quote function called", async () => {
    h.quote = QUOTE
    const r = await confirmAirtimeByText(SENDER, sms({ airtimeCashbackPay: 9.69, airtimeCashbackWalletPay: 9.5 }))
    expect(r.orderId).toBe(order().id)
    expect(order()).toMatchObject({ total_paid: 10, airtime_amount: 9.52, fee_amount: 0.48 })
    expect(order().payment_fee_amount).toBeUndefined()
    expect(order().customer_cashback_amount).toBeUndefined()
    expect(r.delivers).toBe(9.52)
    expect(bots.airtimeRequote).not.toHaveBeenCalled()
    for (const [name, v] of Object.entries(bots)) {
      if (typeof v === "function" && /quote|cashback/i.test(name) && name !== "uzoCashbackAirtimeColumns") {
        expect(v, name).not.toHaveBeenCalled()
      }
    }
    await runNoWait()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBe(10)
  })

  it("isAirtimeEnabled false: no row, no orderId", async () => {
    h.enabled = false
    const r = await confirmAirtimeByText(SENDER, sms())
    expect(r.orderId).toBeUndefined()
    expect(rows("airtime_orders")).toHaveLength(0)
    expect(h.afterFns).toHaveLength(0)
  })

  it("amount above getAirtimeLimits max: no row, no orderId", async () => {
    h.limits = { min: 1, max: 5 }
    const r = await confirmAirtimeByText(SENDER, sms())
    expect(r.orderId).toBeUndefined()
    expect(rows("airtime_orders")).toHaveLength(0)
    expect(h.afterFns).toHaveLength(0)
  })

  it.each([NaN, Infinity, -Infinity, 0, -5, 10.555, 1.005, undefined])("an unusable amount (%s) is refused: no row, no orderId, no charge", async (amount) => {
    const r = await confirmAirtimeByText(SENDER, sms({ airtimeAmount: amount }))
    expect(r.orderId).toBeUndefined()
    expect(rows("airtime_orders")).toHaveLength(0)
    expect(h.afterFns).toHaveLength(0)
  })

  it("a 2-decimal amount is still accepted", async () => {
    const r = await confirmAirtimeByText(SENDER, sms({ airtimeAmount: 10.5 }))
    expect(r.orderId).toBe(order().id)
  })

  it("no MoMo provider for the sender: no row, no orderId", async () => {
    const r = await confirmAirtimeByText(SENDER, sms({ dialingPhone: "+233990000000" }))
    expect(r.orderId).toBeUndefined()
    expect(rows("airtime_orders")).toHaveLength(0)
  })

  it("the fee tier is read at confirm: a dealer sender gets the dealer rate in airtime_amount", async () => {
    h.dialer = { userId: "u9", role: "dealer", rateTier: "dealer" }
    const r = await confirmAirtimeByText(SENDER, sms())
    // dealer rate 2 on GHS 10: fee 0.20, delivered 9.80 (the customer rate gives 9.52)
    expect(r.delivers).toBe(9.8)
    expect(order()).toMatchObject({ airtime_amount: 9.8, fee_amount: 0.2, total_paid: 10 })
  })
})
