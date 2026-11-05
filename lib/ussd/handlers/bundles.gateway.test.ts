// Uzo data bundles (handleConfirm / handlePaymentMethod) with the REAL startMomoCharge. Only the network edges are
// fakes (lib/ussd/gateway-test-kit.ts). Price 10, Paystack fee 3%: Paystack 10.30, Hubtel 10.00.
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  afterFns: [] as Array<() => Promise<void>>,
  sessions: new Map<string, any>(),
  charge: null as any,
  sms: null as any,
  verified: new Set<string>(),
}))

vi.mock("@supabase/supabase-js", async () => (await import("@/lib/ussd/gateway-test-kit")).supabaseMock())
vi.mock("@/lib/payment-gateway/read-config", async () => (await import("@/lib/ussd/gateway-test-kit")).readConfigMock())
vi.mock("@/lib/payment-gateway/hubtel-readiness", async () => (await import("@/lib/ussd/gateway-test-kit")).readinessMock())
vi.mock("@/lib/hubtel-pay/client", async (orig) => (await import("@/lib/ussd/gateway-test-kit")).relayMock(await orig()))
vi.mock("@/lib/hubtel-pay/alert-throttle", async () => (await import("@/lib/ussd/gateway-test-kit")).alertMock())
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => { h.afterFns.push(fn) } }))
vi.mock("../session", () => ({ setSession: vi.fn(async (id: string, s: any) => { h.sessions.set(id, s) }) }))
vi.mock("../resolve-email", () => ({ resolveEmail: vi.fn(async () => "payer@example.com") }))
vi.mock("../wallet-balance", () => ({ liveWalletBalance: vi.fn(async () => undefined) }))
vi.mock("../fulfill", () => ({ fulfillUssdOrder: vi.fn() }))
vi.mock("@/lib/paystack", async (orig) => ({
  ...(await orig<object>()),
  chargeMobileMoney: vi.fn(async (p: any) => h.charge(p)),
  submitOtp: vi.fn(),
}))
vi.mock("../../sms-service", () => ({ sendSMS: vi.fn(async (p: any) => h.sms(p)), SMSTemplates: { ussdOtpRequired: () => "otp" } }))
vi.mock("../../whatsapp-bot/send", () => ({ sendWhatsAppText: vi.fn() }))
vi.mock("../../app-settings", () => ({ getJoinCommunityLink: vi.fn(async () => "") }))
vi.mock("../../network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn(async () => ({ enabled: false, map: {} })) }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({ isRecipientBlocked: vi.fn(async () => false), RECIPIENT_BLOCKED_PROMPT: "" }))
vi.mock("../../ussd-service-visibility", () => ({ getUssdServiceVisibility: vi.fn(async () => ({})) }))
vi.mock("@/lib/storefront-otp", async (orig) => ({
  ...(await orig<object>()),
  isPhoneOtpVerified: vi.fn(async (p: string) => h.verified.has(p)),
}))

import { handleConfirm, handlePaymentMethod } from "./bundles"
import { chargeMobileMoney } from "@/lib/paystack"
import { sendWhatsAppText } from "../../whatsapp-bot/send"
import { gatewayConfig, hubtelRows, kit, resetKit, rows } from "../gateway-test-kit"

const DIAL = "+233244123456"
const session = (over: Record<string, unknown> = {}): any => ({
  step: "CONFIRM", network: "MTN", paystackProvider: "mtn", bundleId: "p1", bundleSize: "1GB", bundlePrice: 10,
  recipientPhone: "0201234567", dialingPhone: DIAL, effectivePriceTier: "regular", ...over,
})

async function runAfter() {
  const fns = h.afterFns.splice(0)
  const done = Promise.all(fns.map((f) => f()))
  await vi.advanceTimersByTimeAsync(5000)
  await done
}
const order = () => rows("ussd_orders")[0]
const paystackPrice = 10.3

beforeEach(() => {
  vi.useFakeTimers()
  resetKit()
  h.afterFns = []
  h.sessions.clear()
  h.charge = async (p: any) => ({ status: "pay_offline", reference: p.reference })
  h.sms = async () => {}
  h.verified.clear()
  vi.mocked(chargeMobileMoney).mockClear()
  vi.mocked(sendWhatsAppText).mockClear()
  kit.db.packages = [{ id: "p1", price: 10, dealer_price: 8, is_available: true }]
  kit.db.app_settings = [{ key: null, paystack_fee_percentage: 3 }]
})

describe("Uzo bundles on Paystack (unchanged)", () => {
  it("writes and charges price + fee with today's params; no Hubtel row", async () => {
    const r = await handleConfirm("1", "S1", session())
    expect(r.message).toContain("MoMo prompt sent to 0244123456")
    expect(order().amount).toBeCloseTo(paystackPrice, 2)
    await runAfter()
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toEqual({
      email: "payer@example.com", amount: order().amount, phone: DIAL, provider: "mtn", reference: order().id,
      metadata: { source: "ussd", ussd_order_id: order().id, recipient_phone: "0201234567", network: "MTN", package_size: "1GB" },
    })
    expect(hubtelRows()).toHaveLength(0)
    expect(kit.receive).not.toHaveBeenCalled()
    expect(order()).toMatchObject({ paystack_reference: order().id, payment_status: "pending" })
    expect(rows("payment_attempts")[0]).toMatchObject({ reference: order().id, amount: 10, payment_type: "ussd" })
  })

  it("a Paystack error still fails the order", async () => {
    h.charge = async () => { throw new Error("Paystack charge failed (HTTP 400)") }
    await handleConfirm("1", "S1", session())
    await runAfter()
    expect(order()).toMatchObject({ order_status: "failed", payment_status: "failed" })
  })

  it("send_otp still marks otp_required and texts the dialler", async () => {
    h.charge = async (p: any) => ({ status: "send_otp", reference: p.reference })
    const sms = vi.fn(async () => {})
    h.sms = sms
    await handleConfirm("1", "S1", session())
    await runAfter()
    expect(order().payment_status).toBe("otp_required")
    expect(sms).toHaveBeenCalledTimes(1)
    expect(sendWhatsAppText).not.toHaveBeenCalled()
    expect(h.sessions.get("S1")).toBeUndefined() // the Uzo path leaves the redial to find the order
    expect(h.sessions.get(DIAL)).toBeUndefined()
  })
})

describe("Uzo bundles on Hubtel", () => {
  beforeEach(() => { kit.config = gatewayConfig(["ussd"]) })

  it("accepted: the order carries no Paystack fee and the dialler gets one Hubtel prompt, even for another recipient", async () => {
    await handleConfirm("1", "S1", session({ recipientPhone: "0551234567" }))
    expect(order().amount).toBe(10)
    await runAfter()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(kit.receive).toHaveBeenCalledTimes(1)
    expect(kit.receive.mock.calls[0][0]).toMatchObject({ msisdn: "233244123456", channel: "mtn-gh", amount: 10, description: "Payment" })
    expect(hubtelRows()[0]).toMatchObject({ internal_reference: order().id, surface: "ussd", amount_pesewas: 1000, status: "pending" })
    expect(order()).toMatchObject({ paystack_reference: order().id, payment_status: "pending", order_status: "pending" })
  })

  it("send_otp never fires on Hubtel", async () => {
    const sms = vi.fn(async () => {})
    h.sms = sms
    await handleConfirm("1", "S1", session())
    await runAfter()
    expect(order().payment_status).toBe("pending")
    expect(sms).not.toHaveBeenCalled()
  })

  it("refused: falls back to Paystack at price + fee, the order moved to that price before the charge", async () => {
    kit.receive.mockImplementation(async () => ({ kind: "refused", code: "4000", message: "no" }))
    let amountAtCharge: number | undefined
    h.charge = async (p: any) => { amountAtCharge = Number(order().amount); return { status: "pay_offline", reference: p.reference } }
    await handleConfirm("1", "S1", session())
    await runAfter()
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBeCloseTo(paystackPrice, 2)
    expect(amountAtCharge).toBeCloseTo(paystackPrice, 2)
    expect(hubtelRows()[0].status).toBe("failed")
    expect(order().payment_status).toBe("pending")
  })

  it("refused but the order can't be moved to the Paystack price: nothing is charged", async () => {
    kit.receive.mockImplementation(async () => {
      order().amount = 12 // changed under us: the guarded write matches no row
      return { kind: "refused", code: "4000", message: "no" }
    })
    await handleConfirm("1", "S1", session())
    await runAfter()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(order().payment_status).toBe("failed")
  })

  it("unknown: no failure, no Paystack, the attempt stays pending", async () => {
    kit.receive.mockImplementation(async () => ({ kind: "unknown", code: "timeout", message: "slow" }))
    await handleConfirm("1", "S1", session())
    await runAfter()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(order()).toMatchObject({ payment_status: "pending", order_status: "pending", paystack_reference: order().id })
    expect(hubtelRows()[0].status).toBe("pending")
  })

  it("Hubtel not ready: Paystack at price + fee from the start", async () => {
    kit.ready = false
    await handleConfirm("1", "S1", session())
    expect(order().amount).toBeCloseTo(paystackPrice, 2)
    await runAfter()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBeCloseTo(paystackPrice, 2)
    expect(kit.receive).not.toHaveBeenCalled()
  })

  it("wallet detour: MoMo picked twice for the same order sends one Hubtel prompt and no Paystack", async () => {
    const r = await handleConfirm("1", "S1", session({ userId: "u1", walletBalance: 50 }))
    expect(r.message).not.toContain("MoMo prompt sent")
    const s = h.sessions.get("S1")
    expect(s).toMatchObject({ step: "PAYMENT_METHOD", pendingOrderId: order().id, pendingOrderAmount: { orderId: order().id, amount: 10 } })
    expect(order().amount).toBe(10)
    await handlePaymentMethod("2", "S1", s)
    await runAfter()
    await handlePaymentMethod("2", "S1", s)
    await runAfter()
    expect(kit.receive).toHaveBeenCalledTimes(1)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(hubtelRows()).toHaveLength(1)
    expect(order().payment_status).toBe("pending")
  })

  it("wallet detour on an order written at the Paystack price: MoMo goes to Paystack at that price", async () => {
    // Written while the surface was on Paystack (no pendingOrderAmount), charged after the switch.
    kit.config = gatewayConfig()
    await handleConfirm("1", "S1", session({ userId: "u1", walletBalance: 50 }))
    const s = h.sessions.get("S1")
    expect(s.pendingOrderAmount).toBeUndefined()
    kit.config = gatewayConfig(["ussd"])
    await handlePaymentMethod("2", "S1", s)
    await runAfter()
    expect(kit.receive).not.toHaveBeenCalled()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBeCloseTo(paystackPrice, 2)
  })

  it("a Hubtel price recorded for an earlier order never prices this one", async () => {
    kit.config = gatewayConfig()
    await handleConfirm("1", "S1", session({ userId: "u1", walletBalance: 50 }))
    const s = { ...h.sessions.get("S1"), pendingOrderAmount: { orderId: "an-earlier-order", amount: 10 } }
    kit.config = gatewayConfig(["ussd"])
    await handlePaymentMethod("2", "S1", s)
    await runAfter()
    expect(kit.receive).not.toHaveBeenCalled()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBeCloseTo(paystackPrice, 2)
  })

  it("the Paystack session is unchanged: no pendingOrderAmount on the wallet detour", async () => {
    kit.config = gatewayConfig()
    await handleConfirm("1", "S1", session({ userId: "u1", walletBalance: 50 }))
    expect(h.sessions.get("S1")).not.toHaveProperty("pendingOrderAmount")
  })
})

describe("WhatsApp (shared handler): surface whatsapp, the owner is the sender", () => {
  beforeEach(() => { kit.config = gatewayConfig(["whatsapp"]) })

  it("the sender's own number goes to Hubtel on the whatsapp surface", async () => {
    await handleConfirm("1", "233244123456", session({ dialingPhone: "0244123456" }), "whatsapp")
    await runAfter()
    expect(kit.receive).toHaveBeenCalledTimes(1)
    expect(hubtelRows()[0].surface).toBe("whatsapp")
    expect(order().amount).toBe(10)
  })

  it("a typed number that isn't the sender's goes to Paystack at price + fee", async () => {
    await handleConfirm("1", "233244123456", session({ dialingPhone: "0551234567" }), "whatsapp")
    expect(order().amount).toBeCloseTo(paystackPrice, 2)
    await runAfter()
    expect(kit.receive).not.toHaveBeenCalled()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toMatchObject({ phone: "0551234567", amount: order().amount })
  })

  it("another number, even an OTP-verified one, goes to Paystack at price + fee", async () => {
    h.verified.add("0551234567")
    await handleConfirm("1", "233244123456", session({ dialingPhone: "0551234567" }), "whatsapp")
    expect(order().amount).toBeCloseTo(paystackPrice, 2)
    await runAfter()
    expect(kit.receive).not.toHaveBeenCalled()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toMatchObject({ phone: "0551234567", amount: order().amount })
  })

  it("PAYMENT_METHOD: an OTP-verified other number goes to Paystack at price + fee", async () => {
    h.verified.add("0551234567")
    await handleConfirm("1", "233244123456", session({ dialingPhone: "0551234567", userId: "u1", walletBalance: 50 }), "whatsapp")
    expect(order().amount).toBeCloseTo(paystackPrice, 2)
    await handlePaymentMethod("2", "233244123456", h.sessions.get("233244123456"), "whatsapp")
    await runAfter()
    expect(kit.receive).not.toHaveBeenCalled()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBeCloseTo(paystackPrice, 2)
  })
})
