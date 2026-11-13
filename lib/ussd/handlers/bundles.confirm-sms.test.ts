// handleConfirm per channel. The ussd and whatsapp blocks are CHARACTERISATION tests, written against the code before
// the sms channel existed: they pin what the live bots do today. The sms block covers the text-to-buy channel.
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  afterFns: [] as Array<() => Promise<void>>,
  charge: null as any,
}))

vi.mock("@supabase/supabase-js", async () => (await import("@/lib/ussd/gateway-test-kit")).supabaseMock())
vi.mock("@/lib/payment-gateway/read-config", async () => (await import("@/lib/ussd/gateway-test-kit")).readConfigMock())
vi.mock("@/lib/payment-gateway/hubtel-readiness", async () => (await import("@/lib/ussd/gateway-test-kit")).readinessMock())
vi.mock("@/lib/hubtel-pay/client", async (orig) => (await import("@/lib/ussd/gateway-test-kit")).relayMock(await orig()))
vi.mock("@/lib/hubtel-pay/alert-throttle", async () => (await import("@/lib/ussd/gateway-test-kit")).alertMock())
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => { h.afterFns.push(fn) } }))
vi.mock("../session", () => ({ setSession: vi.fn(async () => {}) }))
vi.mock("../resolve-email", () => ({ resolveEmail: vi.fn(async () => "payer@example.com") }))
vi.mock("../wallet-balance", () => ({ liveWalletBalance: vi.fn(async () => undefined) }))
vi.mock("../fulfill", () => ({ fulfillUssdOrder: vi.fn() }))
vi.mock("@/lib/paystack", async (orig) => ({
  ...(await orig<object>()),
  chargeMobileMoney: vi.fn(async (p: any) => h.charge(p)),
  submitOtp: vi.fn(),
}))
vi.mock("../gateway-charge", async (orig) => {
  const real = await orig<typeof import("../gateway-charge")>()
  return { ...real, startUssdCharge: vi.fn(real.startUssdCharge) }
})
vi.mock("../../sms-service", () => ({ sendSMS: vi.fn(async () => {}), SMSTemplates: { ussdOtpRequired: () => "otp" } }))
vi.mock("../../whatsapp-bot/send", () => ({ sendWhatsAppText: vi.fn() }))
vi.mock("../../whatsapp-bot/session", () => ({ setWaSession: vi.fn(async () => {}) }))
vi.mock("../../app-settings", () => ({ getJoinCommunityLink: vi.fn(async () => "") }))
vi.mock("../../network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn(async () => ({ enabled: false, map: {} })) }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({ isRecipientBlocked: vi.fn(async () => false), RECIPIENT_BLOCKED_PROMPT: "" }))
vi.mock("../../ussd-service-visibility", () => ({ getUssdServiceVisibility: vi.fn(async () => ({})) }))
vi.mock("@/lib/storefront-otp", async (orig) => ({ ...(await orig<object>()), isPhoneOtpVerified: vi.fn(async () => false) }))

import { handleConfirm } from "./bundles"
import { chargeMobileMoney } from "@/lib/paystack"
import { sendSMS } from "../../sms-service"
import { sendWhatsAppText } from "../../whatsapp-bot/send"
import { setWaSession } from "../../whatsapp-bot/session"
import { setSession } from "../session"
import { startUssdCharge } from "../gateway-charge"
import { gatewayConfig, hubtelRows, kit, resetKit, rows } from "../gateway-test-kit"

const DIAL = "+233200000101"
const session = (over: Record<string, unknown> = {}): any => ({
  step: "CONFIRM", network: "MTN", paystackProvider: "vod" /* 020 numbers are Telecel payers; the bundle network is the recipient's */, bundleId: "p1", bundleSize: "1GB", bundlePrice: 10,
  recipientPhone: "0200000102", dialingPhone: DIAL, effectivePriceTier: "regular", ...over,
})
const WALLET = { userId: "u1", walletBalance: 50 }
const order = () => rows("ussd_orders")[0]

/** Starts the captured after() callbacks without advancing timers (only microtasks flush). Await the result to finish. */
async function launch(): Promise<{ done: Promise<unknown> }> {
  const fns = h.afterFns.splice(0)
  const done = Promise.all(fns.map((f) => f()))
  await vi.advanceTimersByTimeAsync(0)
  return { done }
}
/** Starts them and waits for them to finish WITHOUT advancing timers: hangs (times out) if a wait remains. */
async function runNoWait() {
  const { done } = await launch()
  await done
}
/** Starts them and runs any wait out. */
async function runAfter() {
  const { done } = await launch()
  await vi.advanceTimersByTimeAsync(5000)
  await done
}

beforeEach(() => {
  vi.useFakeTimers()
  resetKit()
  h.afterFns = []
  h.charge = async (p: any) => ({ status: "pay_offline", reference: p.reference })
  for (const m of [chargeMobileMoney, sendSMS, sendWhatsAppText, setWaSession, setSession, startUssdCharge]) vi.mocked(m as any).mockClear()
  kit.db.packages = [{ id: "p1", price: 10, dealer_price: 8, is_available: true }]
  kit.db.app_settings = [{ key: null, paystack_fee_percentage: 3 }]
})

describe("characterisation: ussd and whatsapp are unchanged", () => {
  it("ussd, not wallet-eligible: order row, end message, charge on the ussd surface after the wait", async () => {
    const r = await handleConfirm("1", "S1", session())
    expect(r).toEqual({
      message: "MoMo prompt sent to 0200000101. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.",
      ussdServiceOp: 17,
    })
    expect(Object.keys(r).sort()).toEqual(["message", "ussdServiceOp"])
    expect(order()).toMatchObject({
      dialing_phone: DIAL, recipient_phone: "0200000102", network: "MTN", paystack_provider: "vod", package_id: "p1",
      package_size: "1GB", price_tier: "regular", parent_shop_id: null, parent_profit_amount: null, shop_owner_id: null,
      order_status: "pending", payment_status: "pending",
    })
    expect(order().amount).toBeCloseTo(10.3, 2)
    expect(setSession).not.toHaveBeenCalled()
    const { done } = await launch()
    expect(startUssdCharge).not.toHaveBeenCalled() // still inside the 3 s wait
    await vi.advanceTimersByTimeAsync(2999)
    expect(startUssdCharge).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(startUssdCharge).toHaveBeenCalledTimes(1)
    await done
    expect(vi.mocked(startUssdCharge).mock.calls[0][0]).toMatchObject({ surface: "ussd", verifiedPayer: true })
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].metadata).toMatchObject({ source: "ussd" })
  })

  it("ussd, wallet-eligible: PAYMENT_METHOD session, wallet menu, no charge", async () => {
    const s = session(WALLET)
    const r = await handleConfirm("1", "S1", s)
    expect(r.ussdServiceOp).toBe(2)
    expect(r.message).toContain("GHS 50.00")
    expect(Object.keys(r).sort()).toEqual(["message", "ussdServiceOp"])
    expect(setSession).toHaveBeenCalledTimes(1)
    expect(setSession).toHaveBeenCalledWith("S1", expect.objectContaining({ step: "PAYMENT_METHOD", pendingOrderId: order().id }))
    expect(h.afterFns).toHaveLength(0)
    expect(startUssdCharge).not.toHaveBeenCalled()
  })

  it("whatsapp, not wallet-eligible: same order row, charge on the whatsapp surface after the wait", async () => {
    const r = await handleConfirm("1", "233200000101", session({ dialingPhone: "0200000101" }), "whatsapp")
    expect(Object.keys(r).sort()).toEqual(["message", "ussdServiceOp"])
    expect(r.message).toContain("MoMo prompt sent to 0200000101")
    expect(order()).toMatchObject({ dialing_phone: "0200000101", order_status: "pending", payment_status: "pending" })
    const { done } = await launch()
    await vi.advanceTimersByTimeAsync(2999)
    expect(startUssdCharge).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(vi.mocked(startUssdCharge).mock.calls[0][0]).toMatchObject({ surface: "whatsapp", verifiedPayer: true })
    expect(setSession).not.toHaveBeenCalled()
  })

  it("whatsapp, wallet-eligible: PAYMENT_METHOD detour, no charge", async () => {
    const r = await handleConfirm("1", "233200000101", session({ dialingPhone: "0200000101", ...WALLET }), "whatsapp")
    expect(r.ussdServiceOp).toBe(2)
    expect(setSession).toHaveBeenCalledWith("233200000101", expect.objectContaining({ step: "PAYMENT_METHOD" }))
    expect(startUssdCharge).not.toHaveBeenCalled()
  })

  it("an opts-less call never gets orderId or amount, whatever the channel", async () => {
    for (const ch of ["ussd", "whatsapp"] as const) {
      const r: any = await handleConfirm("1", "S1", session(), ch)
      expect(r.orderId).toBeUndefined()
      expect(r.amount).toBeUndefined()
    }
  })
})

describe("sms channel (text-to-buy)", () => {
  beforeEach(() => {
    kit.config = gatewayConfig()
    kit.config.surfaces.sms_order = { gateway: "paystack", mode: "direct", feeBearer: "customer" }
  })
  const SMS = () => handleConfirm("1", "sms-S1", session(), "sms", { momoOnly: true })

  it("returns the created order id and the amount written on the row", async () => {
    const r = await SMS()
    expect(r.orderId).toBe(order().id)
    expect(r.amount).toBe(order().amount)
    expect(r.amount).toBeCloseTo(10.3, 2)
    expect(setSession).not.toHaveBeenCalled()
    expect(setWaSession).not.toHaveBeenCalled()
  })

  it("a wallet-eligible session with momoOnly skips PAYMENT_METHOD and starts the charge", async () => {
    const r = await handleConfirm("1", "sms-S1", session(WALLET), "sms", { momoOnly: true })
    expect(r.orderId).toBe(order().id)
    expect(setSession).not.toHaveBeenCalled()
    expect(h.afterFns).toHaveLength(1)
    await runNoWait()
    expect(startUssdCharge).toHaveBeenCalledTimes(1)
  })

  it("charges on sms_order, verified payer, with no wait and source sms", async () => {
    await SMS()
    await runNoWait() // timers NOT advanced
    expect(startUssdCharge).toHaveBeenCalledTimes(1)
    expect(vi.mocked(startUssdCharge).mock.calls[0][0]).toMatchObject({ surface: "sms_order", verifiedPayer: true })
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].metadata).toMatchObject({ source: "sms", ussd_order_id: order().id })
  })

  it("send_otp marks otp_required and sends nothing", async () => {
    h.charge = async (p: any) => ({ status: "send_otp", reference: p.reference })
    await SMS()
    await runNoWait()
    expect(order().payment_status).toBe("otp_required")
    expect(sendSMS).not.toHaveBeenCalled()
    expect(sendWhatsAppText).not.toHaveBeenCalled()
    expect(setWaSession).not.toHaveBeenCalled()
    expect(setSession).not.toHaveBeenCalled()
  })

  it("a charge that throws fails the order", async () => {
    h.charge = async () => { throw new Error("Paystack charge failed (HTTP 400)") }
    await SMS()
    await runNoWait()
    expect(order()).toMatchObject({ order_status: "failed", payment_status: "failed" })
  })

  it("a price changed since the session was built creates no order and no orderId", async () => {
    kit.db.packages = [{ id: "p1", price: 12, dealer_price: 8, is_available: true }]
    const r = await SMS()
    expect(r.orderId).toBeUndefined()
    expect(r.amount).toBeUndefined()
    expect(rows("ussd_orders")).toHaveLength(0)
    expect(h.afterFns).toHaveLength(0)
  })

  it("never writes a Hubtel row on a paystack-configured surface", async () => {
    await SMS()
    await runNoWait()
    expect(hubtelRows()).toHaveLength(0)
  })
})
