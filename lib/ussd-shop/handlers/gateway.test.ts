// Uzo shop menu (bundles, airtime, results checker) with the REAL startMomoCharge. The shop menu only ever charges
// the dialler. Bundles: price 10 + 3% fee (Paystack 10.30, Hubtel 10.00). Cashback airtime: payAmount 9.69 (base 9.50
// + fee 0.19). Legacy airtime and vouchers add no Paystack fee.
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ afterFns: [] as Array<() => Promise<void>>, charge: null as any, quote: null as any }))

vi.mock("@supabase/supabase-js", async () => (await import("@/lib/ussd/gateway-test-kit")).supabaseMock())
vi.mock("@/lib/payment-gateway/read-config", async () => (await import("@/lib/ussd/gateway-test-kit")).readConfigMock())
vi.mock("@/lib/payment-gateway/hubtel-readiness", async () => (await import("@/lib/ussd/gateway-test-kit")).readinessMock())
vi.mock("@/lib/hubtel-pay/client", async (orig) => (await import("@/lib/ussd/gateway-test-kit")).relayMock(await orig()))
vi.mock("@/lib/hubtel-pay/alert-throttle", async () => (await import("@/lib/ussd/gateway-test-kit")).alertMock())
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => { h.afterFns.push(fn) } }))
vi.mock("../session", () => ({ setSession: vi.fn(async () => {}) }))
vi.mock("@/lib/ussd/resolve-email", () => ({ resolveEmail: vi.fn(async () => "payer@example.com") }))
vi.mock("@/lib/paystack", async (orig) => ({ ...(await orig<object>()), chargeMobileMoney: vi.fn(async (p: any) => h.charge(p)) }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(async () => {}), SMSTemplates: { ussdOtpRequired: () => "otp" } }))
vi.mock("@/lib/secure-random", () => ({ secureReference: () => "REF" }))
vi.mock("@/lib/shop-commerce/pricing", () => ({
  fetchShopBundles: vi.fn(), verifyBundlePrice: vi.fn(async () => ({ verifiedPrice: 10, profitAmount: 1, parentProfitAmount: null })),
}))
vi.mock("@/lib/shop-commerce/shop-code", () => ({ getCanonicalShopName: vi.fn(async () => "Shop") }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn(async () => ({ enabled: false, map: {} })) }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({ isRecipientBlocked: vi.fn(async () => false), RECIPIENT_BLOCKED_PROMPT: "" }))
vi.mock("./shop", () => ({ productMenuVisibility: vi.fn(async () => ({})) }))
vi.mock("@/lib/ussd/handlers/results-checker", () => ({ buildRcBoardOptions: vi.fn(async () => []) }))
vi.mock("@/lib/results-checker-service", () => ({
  isExamBoardEnabled: vi.fn(async () => true), getAvailableCount: vi.fn(async () => 10), getMaxQuantity: vi.fn(async () => 10),
  calculateRCPrice: vi.fn(async () => ({ unitPrice: 20, totalPaid: 40, merchantCommission: 2 })), getRCBulkHint: vi.fn(async () => null),
}))
vi.mock("@/lib/ussd-service-visibility", () => ({ getUssdServiceVisibility: vi.fn(async () => ({ airtime: true, cashbackAirtime: true })) }))
vi.mock("@/lib/cashback/storefront-airtime", () => ({ quoteBotAirtime: vi.fn(async (_n: string, face: number) => (h.quote ? { ...h.quote, faceAmount: face } : null)) }))
vi.mock("@/lib/airtime-pricing", async (orig) => ({
  ...(await orig<object>()),
  isAirtimeEnabled: vi.fn(async () => true),
  getAirtimeLimits: vi.fn(async () => ({ min: 1, max: 500 })),
  airtimeBaseFeeRate: vi.fn(async () => 5),
}))

import { handleConfirm } from "./bundles"
import { handleShopAirtimeConfirm } from "./airtime"
import { handleShopRcConfirm } from "./results-checker"
import { chargeMobileMoney } from "@/lib/paystack"
import { gatewayConfig, hubtelRows, kit, resetKit, rows } from "@/lib/ussd/gateway-test-kit"

const DIAL = "+233244123456"
const SHOP = "shop-1"
const QUOTE = {
  applied: true, faceAmount: 10, rate: 10, share: 50, commission: 1, customerCashback: 0.5, shopShare: 0.2,
  payAmount: 9.69, datagodKeeps: 0.5, provider: "hubtel", base: 9.5, paymentFee: 0.19, feeRate: 1.95,
}
const bundleSession = (over: any = {}): any => ({
  step: "CONFIRM", shopCodeId: "c1", shopId: SHOP, shopName: "Shop", network: "MTN", paystackProvider: "mtn", bundleId: "p1",
  bundleSize: "1GB", bundlePrice: 10, recipientPhone: "0201234567", dialingPhone: DIAL, ...over,
})
const airtimeSession = (over: any = {}): any => ({
  step: "SHOP_AIRTIME_CONFIRM", shopId: SHOP, shopName: "Shop", dialingPhone: DIAL, airtimeRecipient: "0201234567",
  airtimeNetwork: "MTN", airtimeAmount: 10, airtimeFee: 0, airtimeToDeliver: 10, airtimeCashbackPay: 9.69, ...over,
})
const rcSession = (): any => ({ step: "SHOP_RC_CONFIRM", shopId: SHOP, shopName: "Shop", dialingPhone: DIAL, rcBoard: "WASSCE", rcQty: 2, rcTotal: 40 })

async function runAfter() {
  const done = Promise.all(h.afterFns.splice(0).map((f) => f()))
  await vi.advanceTimersByTimeAsync(5000)
  await done
}
const refuse = () => kit.receive.mockImplementation(async () => ({ kind: "refused", code: "4000", message: "no" }))
const unknown = () => kit.receive.mockImplementation(async () => ({ kind: "unknown", code: "timeout", message: "slow" }))

beforeEach(() => {
  vi.useFakeTimers()
  resetKit()
  h.afterFns = []
  h.quote = null
  h.charge = async (p: any) => ({ status: "pay_offline", reference: p.reference })
  vi.mocked(chargeMobileMoney).mockClear()
  kit.db.app_settings = [{ key: null, paystack_fee_percentage: 3 }]
  kit.db.user_shops = [{ id: SHOP, user_id: "owner", users: { email: "o@x.com" }, airtime_markup_mtn: 0 }]
  kit.db.users = [{ id: "owner", role: "agent" }]
})

describe("shop bundles", () => {
  const order = () => rows("ussd_shop_orders")[0]

  it("Paystack: price + fee, today's params", async () => {
    await handleConfirm("1", "S1", bundleSession())
    await runAfter()
    expect(order().amount).toBeCloseTo(10.3, 2)
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toEqual({
      email: "payer@example.com", amount: order().amount, phone: DIAL, provider: "mtn", reference: order().id,
      metadata: { source: "ussd_shop", ussd_shop_order_id: order().id, recipient_phone: "0201234567", network: "MTN", package_size: "1GB", shop_id: SHOP },
    })
    expect(hubtelRows()).toHaveLength(0)
  })

  it("Paystack error still fails the order", async () => {
    h.charge = async () => { throw new Error("boom") }
    await handleConfirm("1", "S1", bundleSession())
    await runAfter()
    expect(order()).toMatchObject({ payment_status: "failed", order_status: "failed" })
  })

  describe("on Hubtel", () => {
    beforeEach(() => { kit.config = gatewayConfig(["ussd"]) })

    it("accepted: no Paystack fee, one prompt to the dialler (another recipient)", async () => {
      await handleConfirm("1", "S1", bundleSession())
      expect(order().amount).toBe(10)
      await runAfter()
      expect(kit.receive.mock.calls[0][0]).toMatchObject({ msisdn: "233244123456", amount: 10 })
      expect(chargeMobileMoney).not.toHaveBeenCalled()
      expect(order().payment_status).toBe("pending")
    })

    it("refused: Paystack at price + fee, order moved first", async () => {
      refuse()
      let at: number | undefined
      h.charge = async (p: any) => { at = order().amount; return { status: "pay_offline", reference: p.reference } }
      await handleConfirm("1", "S1", bundleSession())
      await runAfter()
      expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBeCloseTo(10.3, 2)
      expect(at).toBeCloseTo(10.3, 2)
      expect(rows("payment_attempts")[0].amount).toBeCloseTo(10.3, 2)
    })

    it("unknown: not failed, no Paystack", async () => {
      unknown()
      await handleConfirm("1", "S1", bundleSession())
      await runAfter()
      expect(chargeMobileMoney).not.toHaveBeenCalled()
      expect(order().payment_status).toBe("pending")
    })
  })
})

describe("shop airtime", () => {
  const order = () => rows("airtime_orders")[0]

  it("Paystack cashback: payAmount with the fee", async () => {
    h.quote = QUOTE
    await handleShopAirtimeConfirm("1", "S1", airtimeSession())
    await runAfter()
    expect(order()).toMatchObject({ total_paid: 9.69 })
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toMatchObject({ amount: 9.69, phone: DIAL, provider: "mtn", reference: order().id })
    expect(hubtelRows()).toHaveLength(0)
  })

  describe("on Hubtel", () => {
    beforeEach(() => { kit.config = gatewayConfig(["ussd"]) })

    it("cashback accepted: fee dropped", async () => {
      h.quote = QUOTE
      await handleShopAirtimeConfirm("1", "S1", airtimeSession())
      expect(order()).toMatchObject({ total_paid: 9.5, payment_fee_amount: 0 })
      await runAfter()
      expect(kit.receive.mock.calls[0][0].amount).toBe(9.5)
      expect(chargeMobileMoney).not.toHaveBeenCalled()
    })

    it("cashback refused: Paystack at payAmount, order moved back first", async () => {
      h.quote = QUOTE
      refuse()
      let at: any
      h.charge = async (p: any) => { at = { ...order() }; return { status: "pay_offline", reference: p.reference } }
      await handleShopAirtimeConfirm("1", "S1", airtimeSession())
      await runAfter()
      expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBe(9.69)
      expect(at).toMatchObject({ total_paid: 9.69, payment_fee_amount: 0.19 })
    })

    it("unknown: not failed", async () => {
      unknown()
      await handleShopAirtimeConfirm("1", "S1", airtimeSession({ airtimeCashbackPay: undefined, airtimeAmount: 10.5 }))
      await runAfter()
      expect(chargeMobileMoney).not.toHaveBeenCalled()
      expect(order().payment_status).toBe("pending_payment")
    })
  })
})

describe("shop results checker", () => {
  const order = () => rows("results_checker_orders")[0]

  it("Paystack unchanged", async () => {
    await handleShopRcConfirm("1", "S1", rcSession())
    await runAfter()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toMatchObject({ amount: 40, phone: DIAL, provider: "mtn", reference: order().id })
  })

  it("Hubtel accepted at the same amount; refused falls back at the same amount", async () => {
    kit.config = gatewayConfig(["ussd"])
    await handleShopRcConfirm("1", "S1", rcSession())
    await runAfter()
    expect(kit.receive.mock.calls[0][0].amount).toBe(40)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    refuse()
    kit.db.results_checker_orders = []
    await handleShopRcConfirm("1", "S1", rcSession())
    await runAfter()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBe(40)
  })
})
