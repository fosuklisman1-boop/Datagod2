import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// payments/initialize for BOT commission orders (channel 'bots', cs_bill / cs_bundle): amount = paid_amount from the
// DB, no extra fee, opaque reference, neutral labels, neutral fallback email (bot rows have no buyer email), per-payer
// cap keyed on the buyer phone, and no storefront slug required. Same harness as route.test.ts.

const h = vi.hoisted(() => {
  const state = {
    orders: {} as Record<string, any>,
    inserts: [] as { table: string; rows: any[] }[],
    gates: { storefrontOtp: false, storefrontDirect: false, walletOtp: false, walletDirect: false },
    livePayments: [] as { id: string }[],
  }
  const chain = (table: string) => {
    const c: any = {}
    let inserting = false
    for (const m of ["select", "or", "eq", "is", "in", "update", "gte"]) c[m] = () => c
    c.limit = () => (table === "wallet_payments" && !inserting ? Promise.resolve({ data: state.livePayments, error: null }) : c)
    c.single = async () => {
      if (table === "user_shops") return { data: { id: "shop1" }, error: null }
      if (table === "app_settings") return { data: { paystack_fee_percentage: 3, wallet_topups_enabled: true, upgrades_enabled: true }, error: null }
      return { data: null, error: null }
    }
    c.maybeSingle = async () => ({ data: state.orders[table] ?? null, error: null })
    c.insert = (rows: any[]) => (inserting = true, state.inserts.push({ table, rows }), c)
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
const applyRateLimit = vi.fn(async (..._a: any[]) => ({ allowed: true, resetAt: Date.now() }))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: (...a: any[]) => applyRateLimit(...a) }))
vi.mock("@/lib/shop-token", () => ({ verifyShopSession: () => ({ valid: true }) }))
vi.mock("@/lib/storefront-otp", () => ({
  isPhoneOtpVerified: async () => true,
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
const botRow = (o: Record<string, unknown> = {}) => ({
  channel: "bots", shop_id: null, status: "pending", payment_status: "unpaid", paid_amount: 10.11,
  buyer_email: null, buyer_phone: "233241234567", ...o,
})

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest("http://x/api/payments/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId: ORDER_ID, amount: 1, ...body }),
  }))

const PRODUCT_WORDS = /bill|bundle|data|airtime|ecg|water|broadband|dstv|gotv|startimes|cashback|commission/i

beforeEach(() => {
  h.state.orders = { hubtel_bill_orders: botRow(), hubtel_data_orders: botRow({ paid_amount: 10.03, shop_id: "shop1" }) }
  h.state.inserts = []
  h.state.gates = { storefrontOtp: false, storefrontDirect: false, walletOtp: false, walletDirect: false }
  h.state.livePayments = []
  chargeMobileMoney.mockClear()
  initializePayment.mockClear()
  recordPayerPhone.mockClear()
  applyRateLimit.mockClear()
})
afterEach(() => { delete process.env.BOT_PAYMENT_EMAIL })

describe("payments/initialize: bot commission orders", () => {
  for (const [orderType, paid, shop] of [["cs_bill", 10.11, null], ["cs_bundle", 10.03, "shop1"]] as const) {
    it(`${orderType} hosted: paid_amount, no fee, opaque reference, fallback email, neutral labels, no slug`, async () => {
      const res = await post({ orderType })
      expect(res.status).toBe(200)
      expect(initializePayment).toHaveBeenCalledTimes(1)
      const p = initializePayment.mock.calls[0][0]
      expect(p).toMatchObject({ amount: paid, email: "payments@datagod.store", channel: "shop_order", purpose: "Shop order" })
      expect(p.reference).toMatch(/^[0-9a-f]{32}$/)
      expect(p.recipient).toBeUndefined()
      expect(p.redirectUrl).toBe(`https://shop.example/?reference=${p.reference}`)
      expect(p.redirectUrl).not.toMatch(PRODUCT_WORDS)
      expect(JSON.stringify(p.metadata)).not.toMatch(PRODUCT_WORDS)
      expect(p.metadata).toMatchObject({ orderId: ORDER_ID, originalAmount: paid, paystackFee: 0, shopId: shop })

      const wp = h.state.inserts.find((i) => i.table === "wallet_payments")!.rows[0]
      expect(wp).toMatchObject({ order_id: ORDER_ID, order_type: orderType, amount: paid, fee: 0, reference: p.reference, shop_id: shop })
      const pa = h.state.inserts.find((i) => i.table === "payment_attempts")!.rows[0]
      expect(pa).toMatchObject({ payment_type: "shop_order", email: "payments@datagod.store", amount: paid, fee: 0 })

      // per-payer cap keyed on the buyer phone, never on the shared fallback email
      const emailCaps = applyRateLimit.mock.calls.filter((c) => c[1] === "payment_init_email")
      expect(emailCaps.map((c) => c[4])).toEqual(["p:233241234567"])
    })
  }

  it("BOT_PAYMENT_EMAIL overrides the fallback; a buyer email on the row wins", async () => {
    process.env.BOT_PAYMENT_EMAIL = "pay@example.com"
    await post({ orderType: "cs_bill" })
    expect(initializePayment.mock.calls[0][0].email).toBe("pay@example.com")
    initializePayment.mockClear()
    h.state.orders.hubtel_bill_orders = botRow({ buyer_email: "buyer@example.com" })
    await post({ orderType: "cs_bill" })
    expect(initializePayment.mock.calls[0][0].email).toBe("buyer@example.com")
  })

  it("momoDirect: charges paid_amount with the fallback email and records the payer number", async () => {
    h.state.gates.storefrontDirect = true
    const res = await post({ orderType: "cs_bill", momoDirect: true, paymentPhone: "0241234567" })
    expect(res.status).toBe(200)
    const p = chargeMobileMoney.mock.calls[0][0]
    expect(p).toMatchObject({ amount: 10.11, email: "payments@datagod.store", provider: "mtn", channel: "shop_order", purpose: "Shop order" })
    expect(JSON.stringify(p.metadata)).not.toMatch(PRODUCT_WORDS)
    expect(recordPayerPhone).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      rawPhone: "0241234567", baseRow: expect.objectContaining({ shop_id: null, order_id: ORDER_ID, payment_type: "shop_order" }),
    }))
  })

  it("a paid / not pending bot row is refused before any charge", async () => {
    for (const o of [{ payment_status: "paid" }, { status: "failed" }]) {
      h.state.orders.hubtel_bill_orders = botRow(o)
      const res = await post({ orderType: "cs_bill" })
      expect(res.status).toBe(400)
    }
    expect(initializePayment).not.toHaveBeenCalled()
    expect(h.state.inserts.find((i) => i.table === "wallet_payments")).toBeUndefined()
  })

  it("a main-bot row paid through a storefront slug is refused (shop mismatch)", async () => {
    const res = await post({ orderType: "cs_bill", shopSlug: "myshop" })
    expect(res.status).toBe(400)
    expect(initializePayment).not.toHaveBeenCalled()
  })

  it("a storefront row still needs the shop slug ('Invalid request', nothing charged)", async () => {
    h.state.orders.hubtel_bill_orders = botRow({ channel: "storefront", shop_id: "shop1", buyer_email: "b@x.co" })
    const res = await post({ orderType: "cs_bill" })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Invalid request" })
    expect(initializePayment).not.toHaveBeenCalled()
    h.state.orders.hubtel_bill_orders = null
    expect((await post({ orderType: "cs_bill" })).status).toBe(400)
  })

  it("a recent pending payment for the same bot order => 409 PAYMENT_IN_PROGRESS", async () => {
    h.state.livePayments = [{ id: "wp-earlier" }]
    const res = await post({ orderType: "cs_bundle" })
    expect(res.status).toBe(409)
    expect(initializePayment).not.toHaveBeenCalled()
  })
})
