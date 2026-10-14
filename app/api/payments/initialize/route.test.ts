import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Direct MoMo charge (momoDirect) for storefront bill / bundle orders (cs_bill / cs_bundle): same rules as airtime —
// amount from the DB (paid_amount), no extra fee, opaque reference, neutral labels, payer number recorded.

const h = vi.hoisted(() => {
  const state = {
    orders: {} as Record<string, any>,
    inserts: [] as { table: string; rows: any[] }[],
    gates: { storefrontOtp: false, storefrontDirect: true, walletOtp: false, walletDirect: false },
    otpVerified: true,
  }
  const chain = (table: string) => {
    const c: any = {}
    for (const m of ["select", "or", "eq", "is", "in", "update"]) c[m] = () => c
    c.single = async () => {
      if (table === "user_shops") return { data: { id: "shop1" }, error: null }
      if (table === "app_settings") return { data: { paystack_fee_percentage: 3, wallet_topups_enabled: true, upgrades_enabled: true }, error: null }
      return { data: null, error: null }
    }
    c.maybeSingle = async () => ({ data: state.orders[table] ?? null, error: null })
    c.insert = (rows: any[]) => (state.inserts.push({ table, rows }), c)
    c.then = (res: any, rej: any) => Promise.resolve({ data: [{ id: "wp1" }], error: null }).then(res, rej)
    return c
  }
  return { state, fake: { from: chain, auth: { getUser: async () => ({ data: { user: null } }) } } }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
const chargeMobileMoney = vi.fn(async (_p: any) => ({ status: "pay_offline" }))
const initializePayment = vi.fn(async (_p: any) => ({ authorizationUrl: "https://paystack/x", accessCode: "ac", reference: "r" }))
vi.mock("@/lib/paystack", () => ({
  chargeMobileMoney: (p: any) => chargeMobileMoney(p),
  initializePayment: (p: any) => initializePayment(p),
}))
vi.mock("@/lib/shop-handle", () => ({ shopHandleOrFilter: () => "x" }))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() })) }))
vi.mock("@/lib/shop-token", () => ({ verifyShopSession: () => ({ valid: true }) }))
vi.mock("@/lib/storefront-otp", () => ({
  isPhoneOtpVerified: async () => h.state.otpVerified,
  isWalletOtpRequired: async () => h.state.gates.walletOtp,
  isStorefrontOtpRequired: async () => h.state.gates.storefrontOtp,
  isStorefrontDirectChargeEnabled: async () => h.state.gates.storefrontDirect,
  isWalletDirectChargeEnabled: async () => h.state.gates.walletDirect,
}))
vi.mock("@/lib/security-log", () => ({ logSecurityEvent: vi.fn() }))
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified: async () => ({ allowed: true }) }))
vi.mock("@/lib/custom-domain-lookup", () => ({ resolveTrustedBaseUrl: async () => "https://shop.example" }))
const recordPayerPhone = vi.fn(async (..._a: any[]) => {})
vi.mock("@/lib/refunds/payer-phone", () => ({ recordPayerPhone: (...a: any[]) => recordPayerPhone(...a) }))

import { POST } from "./route"

const ORDER_ID = "11111111-2222-3333-4444-555555555555"
const row = (o: Record<string, unknown> = {}) => ({
  channel: "storefront", shop_id: "shop1", status: "pending", payment_status: "unpaid", paid_amount: 98.5,
  buyer_email: "buyer@example.com", ...o,
})

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest("http://x/api/payments/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId: ORDER_ID, shopSlug: "myshop", amount: 1, email: "client@spoof.co", ...body }),
  }))

const PRODUCT_WORDS = /bill|bundle|data|airtime|ecg|water|broadband|dstv|gotv|startimes|cashback|commission/i

beforeEach(() => {
  h.state.orders = { hubtel_bill_orders: row(), hubtel_data_orders: row({ paid_amount: 12.3 }) }
  h.state.inserts = []
  h.state.gates = { storefrontOtp: false, storefrontDirect: true, walletOtp: false, walletDirect: false }
  h.state.otpVerified = true
  chargeMobileMoney.mockClear()
  initializePayment.mockClear()
  recordPayerPhone.mockClear()
})

describe("payments/initialize momoDirect: storefront bill / bundle orders", () => {
  for (const [orderType, table, paid] of [["cs_bill", "hubtel_bill_orders", 98.5], ["cs_bundle", "hubtel_data_orders", 12.3]] as const) {
    it(`${orderType}: charges paid_amount from the DB with no extra fee, opaque reference, neutral labels`, async () => {
      const res = await post({ orderType, momoDirect: true, paymentPhone: "0241234567" })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toMatchObject({ success: true, momoDirect: true, status: "pay_offline" })
      expect(json.reference).toMatch(/^[0-9a-f]{32}$/)

      expect(initializePayment).not.toHaveBeenCalled()
      expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
      const p = chargeMobileMoney.mock.calls[0][0]
      expect(p).toMatchObject({
        amount: paid, email: "buyer@example.com", phone: "0241234567", provider: "mtn", reference: json.reference,
        channel: "shop_order", purpose: "Shop order",
      })
      expect(p.recipient).toBeUndefined()
      expect(JSON.stringify(p.metadata)).not.toMatch(PRODUCT_WORDS)
      expect(p.metadata).toMatchObject({ orderId: ORDER_ID, originalAmount: paid, paystackFee: 0 })

      const wp = h.state.inserts.find((i) => i.table === "wallet_payments")!.rows[0]
      expect(wp).toMatchObject({ order_id: ORDER_ID, order_type: orderType, amount: paid, fee: 0, reference: json.reference, shop_id: "shop1" })
      expect(recordPayerPhone).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reference: json.reference, rawPhone: "0241234567" }))
      void table
    })
  }

  it("Telecel number => vod provider (OTP flow handled by the page)", async () => {
    await post({ orderType: "cs_bill", momoDirect: true, paymentPhone: "0501234567" })
    expect(chargeMobileMoney.mock.calls[0][0].provider).toBe("vod")
  })

  it("direct charge gate off => 400 DIRECT_CHARGE_OFF, nothing charged", async () => {
    h.state.gates.storefrontDirect = false
    const res = await post({ orderType: "cs_bundle", momoDirect: true, paymentPhone: "0241234567" })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "DIRECT_CHARGE_OFF" })
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("OTP gate on: an unverified payment number => 403 OTP_REQUIRED, nothing charged", async () => {
    h.state.gates.storefrontOtp = true
    h.state.otpVerified = false
    const res = await post({ orderType: "cs_bill", momoDirect: true, paymentPhone: "0241234567" })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "OTP_REQUIRED" })
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("an already paid / not pending order is refused before any charge", async () => {
    for (const o of [{ payment_status: "paid" }, { status: "failed" }, { channel: "dashboard" }, { shop_id: "other" }]) {
      h.state.orders.hubtel_bill_orders = row(o)
      const res = await post({ orderType: "cs_bill", momoDirect: true, paymentPhone: "0241234567" })
      expect(res.status).toBe(400)
    }
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("unknown MoMo network => 400, nothing charged", async () => {
    const res = await post({ orderType: "cs_bill", momoDirect: true, paymentPhone: "0311234567" })
    expect(res.status).toBe(400)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("hosted fallback (no momoDirect): with direct charge on, MoMo is stripped; with it off, MoMo stays", async () => {
    await post({ orderType: "cs_bill" })
    expect(initializePayment.mock.calls[0][0].channels).not.toContain("mobile_money")
    expect(initializePayment.mock.calls[0][0].redirectUrl).toBe(`https://shop.example/shop/myshop/payment-confirmation?reference=${initializePayment.mock.calls[0][0].reference}&orderId=${ORDER_ID}`)
    initializePayment.mockClear()
    h.state.gates.storefrontDirect = false
    await post({ orderType: "cs_bill" })
    expect(initializePayment.mock.calls[0][0].channels).toContain("mobile_money")
    expect(initializePayment.mock.calls[0][0].amount).toBe(98.5)
  })
})
