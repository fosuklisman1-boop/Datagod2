import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    settings: {} as Record<string, any>,
    cashbackReadError: false,
    merchantRole: "user",
    shop: { id: "shop-1", user_id: "merchant-1", airtime_markup_mtn: "2", airtime_markup_telecel: "0", airtime_markup_at: "7" } as any,
    provider: "hubtel" as string,
    digiwapyConfigured: true,
    inserts: [] as any[],
    rateLimitKeys: [] as string[],
  }
  // Generic chainable query: every filter returns the chain; awaiting it yields a count (flood guards).
  const chain = (table: string) => {
    const filters: Record<string, any> = {}
    const c: any = {}
    for (const m of ["select", "or", "gte", "neq"]) c[m] = () => c
    c.eq = (col: string, v: any) => ((filters[col] = v), c)
    c.single = async () => {
      if (table === "user_shops") return { data: state.shop, error: null }
      if (table === "users") return { data: { role: state.merchantRole }, error: null }
      if (table === "admin_settings") return { data: { value: state.settings[filters.key] ?? null }, error: null }
      if (table === "airtime_orders") return { data: { id: "order-1" }, error: null }
      return { data: null, error: null }
    }
    c.maybeSingle = async () => {
      if (table === "admin_settings" && filters.key === "commission_cashback_config" && state.cashbackReadError) {
        return { data: null, error: { message: "read failed" } }
      }
      const v = state.settings[filters.key]
      return { data: v === undefined ? null : { value: v }, error: null }
    }
    c.insert = (rows: any[]) => (state.inserts.push(rows[0]), c)
    c.then = (res: any, rej: any) => Promise.resolve({ count: 0, data: null, error: null }).then(res, rej)
    return c
  }
  return { state, fake: { from: chain } }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: vi.fn(async (_req: any, key: string) => (h.state.rateLimitKeys.push(key), { allowed: true, resetAt: Date.now() })),
}))
vi.mock("@/lib/turnstile", () => ({
  isTurnstileEnabled: vi.fn(async () => false),
  verifyTurnstileToken: vi.fn(),
  getRequestIp: vi.fn(),
}))
vi.mock("@/lib/storefront-otp", () => ({
  isStorefrontOtpRequired: vi.fn(async () => false),
  isPhoneOtpVerified: vi.fn(async () => true),
}))
vi.mock("@/lib/secure-random", () => ({ secureReference: () => "AT-REF-1" }))
vi.mock("@/lib/airtime-service", () => ({
  airtimeProviderDeps: {
    getProvider: async () => h.state.provider,
    digiwapyConfigured: () => h.state.digiwapyConfigured,
  },
}))

import { POST } from "./route"

const CASHBACK_ON = {
  enabled: true,
  surfaces: { storefront: true },
  rates: { "airtime_mtn:hubtel": 4, "airtime_at:digiwapy": 3 },
  shares: { airtime: { customer: 0, dealer: 0, storefrontCustomer: 50, storefrontShop: 25 } },
  paymentFee: { airtime: 1.5 },
  storefrontGroups: { airtime: true },
}

const post = (body: Record<string, unknown>) =>
  POST(new Request("http://x/api/shop/airtime/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shopSlug: "myshop", beneficiaryPhone: "0541234567", customerEmail: "a@b.co", ...body }),
  }) as any)

/**
 * The route's pricing + insert row as it was BEFORE cashback (commit a705ce09), copied verbatim.
 * The legacy path must produce exactly this row and response for every input.
 */
function goldenLegacy(amount: number, network: string, baseRate: number, markupRaw: number, bodyPaySeparately: any, customerName?: string) {
  let customMarkupRate = markupRaw
  if (baseRate + customMarkupRate > 10) customMarkupRate = Math.max(0, 10 - baseRate)
  const totalFeeRate = baseRate + customMarkupRate
  const paySeparately = bodyPaySeparately !== undefined ? bodyPaySeparately : true
  let feeAmount: number, totalPrice: number, airtimeToDeliver: number
  if (paySeparately) {
    feeAmount = parseFloat((amount * totalFeeRate / 100).toFixed(2))
    totalPrice = parseFloat((amount + feeAmount).toFixed(2))
    airtimeToDeliver = amount
  } else {
    feeAmount = parseFloat((amount * totalFeeRate / (100 + totalFeeRate)).toFixed(2))
    totalPrice = amount
    airtimeToDeliver = parseFloat((amount - feeAmount).toFixed(2))
  }
  const merchantCommission = parseFloat((airtimeToDeliver * customMarkupRate / 100).toFixed(2))
  return {
    row: {
      reference_code: "AT-REF-1",
      network,
      beneficiary_phone: "0541234567",
      airtime_amount: airtimeToDeliver,
      fee_amount: feeAmount,
      total_paid: totalPrice,
      status: "pending_payment",
      payment_status: "pending_payment",
      shop_id: "shop-1",
      merchant_commission: merchantCommission,
      customer_name: customerName || "Guest",
      customer_email: "a@b.co",
      pay_separately: paySeparately,
    },
    response: { success: true, orderId: "order-1", totalPrice, reference: "AT-REF-1" },
  }
}

beforeEach(() => {
  h.state.settings = { airtime_fee_mtn_customer: { rate: 5 }, airtime_fee_at_customer: { rate: 4 }, airtime_fee_mtn_dealer: { rate: 3 } }
  h.state.cashbackReadError = false
  h.state.merchantRole = "user"
  h.state.provider = "hubtel"
  h.state.digiwapyConfigured = true
  h.state.inserts = []
  h.state.rateLimitKeys = []
})

describe("shop airtime initialize — legacy path is byte-identical", () => {
  const amounts = [1, 2.5, 7.77, 10, 10.005, 33.33, 99.99, 150]
  const scenarios: Array<{ name: string; setup: () => void }> = [
    { name: "no cashback config", setup: () => {} },
    { name: "cashback config read error", setup: () => { h.state.settings.commission_cashback_config = CASHBACK_ON; h.state.cashbackReadError = true } },
    { name: "master switch off", setup: () => { h.state.settings.commission_cashback_config = { ...CASHBACK_ON, enabled: false } } },
    { name: "storefront surface off", setup: () => { h.state.settings.commission_cashback_config = { ...CASHBACK_ON, surfaces: { dashboard: true } } } },
    { name: "airtime storefront group off", setup: () => { h.state.settings.commission_cashback_config = { ...CASHBACK_ON, storefrontGroups: { bills: true } } } },
    { name: "manual provider", setup: () => { h.state.settings.commission_cashback_config = CASHBACK_ON; h.state.provider = "manual" } },
    { name: "digiwapy without env", setup: () => { h.state.settings.commission_cashback_config = CASHBACK_ON; h.state.provider = "digiwapy"; h.state.digiwapyConfigured = false } },
  ]
  for (const s of scenarios) {
    for (const paySeparately of [undefined, true, false]) {
      it(`${s.name}, paySeparately=${paySeparately}`, async () => {
        s.setup()
        for (const amount of amounts) {
          h.state.inserts = []
          const res = await post({ airtimeAmount: amount, network: "MTN", paySeparately, customerName: "Ama" })
          const g = goldenLegacy(amount, "MTN", 5, 2, paySeparately, "Ama")
          expect(res.status).toBe(200)
          expect(h.state.inserts).toHaveLength(1)
          expect(JSON.stringify(h.state.inserts[0])).toBe(JSON.stringify(g.row))
          expect(JSON.stringify(await res.json())).toBe(JSON.stringify(g.response))
        }
      })
    }
  }

  it("hubtel face above Hubtel's cap (150) stays legacy even with cashback on", async () => {
    h.state.settings.commission_cashback_config = CASHBACK_ON
    const res = await post({ airtimeAmount: 150, network: "MTN" })
    expect(JSON.stringify(h.state.inserts[0])).toBe(JSON.stringify(goldenLegacy(150, "MTN", 5, 2, undefined).row))
    expect((await res.json()).totalPrice).toBe(160.5)
  })

  it("10% cap on base + markup (AT: 4% + 7% => markup 6%) unchanged", async () => {
    const res = await post({ airtimeAmount: 20, network: "AT" })
    expect(JSON.stringify(h.state.inserts[0])).toBe(JSON.stringify(goldenLegacy(20, "AT", 4, 7, undefined).row))
    expect(res.status).toBe(200)
  })

  it("legacy expectedPay that matches proceeds unchanged", async () => {
    const g = goldenLegacy(10, "MTN", 5, 2, undefined)
    const res = await post({ airtimeAmount: 10, network: "MTN", expectedPay: g.response.totalPrice })
    expect(JSON.stringify(h.state.inserts[0])).toBe(JSON.stringify(g.row))
    expect(JSON.stringify(await res.json())).toBe(JSON.stringify(g.response))
  })
})

describe("shop airtime initialize — cashback applied", () => {
  beforeEach(() => { h.state.settings.commission_cashback_config = CASHBACK_ON })

  it("face 10 on hubtel: pays 9.95 incl. 0.15 fee, shop share as merchant_commission, snapshot columns", async () => {
    const res = await post({ airtimeAmount: 10, network: "MTN", paySeparately: true, customerName: "Ama" })
    expect(res.status).toBe(200)
    expect(h.state.inserts[0]).toStrictEqual({
      reference_code: "AT-REF-1",
      network: "MTN",
      beneficiary_phone: "0541234567",
      airtime_amount: 10,
      fee_amount: 0,
      total_paid: 9.95,
      status: "pending_payment",
      payment_status: "pending_payment",
      shop_id: "shop-1",
      merchant_commission: 0.1,
      customer_name: "Ama",
      customer_email: "a@b.co",
      pay_separately: false,
      payment_fee_amount: 0.15,
      cashback_amount: 0.2,
      shop_share_amount: 0.1,
      cashback_rate: 4,
      cashback_share: 50,
      cashback_provider: "hubtel",
      expected_commission: 0.4,
    })
    expect(await res.json()).toStrictEqual({
      success: true, orderId: "order-1", totalPrice: 9.95, reference: "AT-REF-1", customerCashback: 0.2, paymentFee: 0.15,
    })
  })

  it("paySeparately=false is ignored on the applied path (face delivered in full)", async () => {
    await post({ airtimeAmount: 10, network: "MTN", paySeparately: false })
    expect(h.state.inserts[0]).toMatchObject({ airtime_amount: 10, total_paid: 9.95, pay_separately: false })
  })

  it("digiwapy (configured) on AT applies with its own rate", async () => {
    h.state.provider = "digiwapy"
    await post({ airtimeAmount: 20, network: "AT" })
    // 2000p * 3% => commission 60p; customer floor(30)=0.30, shop 0.15; base 19.70; fee ceil(29.55)=0.30
    expect(h.state.inserts[0]).toMatchObject({
      airtime_amount: 20, fee_amount: 0, total_paid: 20, merchant_commission: 0.15,
      cashback_amount: 0.3, shop_share_amount: 0.15, payment_fee_amount: 0.3, cashback_provider: "digiwapy", expected_commission: 0.6,
    })
  })

  it("matching expectedPay proceeds", async () => {
    const res = await post({ airtimeAmount: 10, network: "MTN", expectedPay: 9.95 })
    expect(res.status).toBe(200)
    expect(h.state.inserts).toHaveLength(1)
  })
})

describe("shop airtime initialize — expectedPay mismatch => 409", () => {
  it("applied path: 409 with the cashback quote, no insert and no flood-guard counters", async () => {
    h.state.settings.commission_cashback_config = CASHBACK_ON
    const res = await post({ airtimeAmount: 10, network: "MTN", expectedPay: 10.7 })
    expect(res.status).toBe(409)
    expect(await res.json()).toStrictEqual({
      error: "Price updated — please review",
      quote: { faceAmount: 10, payAmount: 9.95, customerCashback: 0.2, paymentFee: 0.15 },
    })
    expect(h.state.inserts).toHaveLength(0)
    expect(h.state.rateLimitKeys).toStrictEqual(["shop_airtime_initialize"])
  })

  it("legacy path (cashback switched off after page load): 409 with the legacy price", async () => {
    const res = await post({ airtimeAmount: 10, network: "MTN", expectedPay: 9.95 })
    expect(res.status).toBe(409)
    expect(await res.json()).toStrictEqual({
      error: "Price updated — please review",
      quote: { faceAmount: 10, payAmount: 10.7, customerCashback: 0, paymentFee: 0 },
    })
    expect(h.state.inserts).toHaveLength(0)
    expect(h.state.rateLimitKeys).toStrictEqual(["shop_airtime_initialize"])
  })

  it("non-numeric expectedPay is a mismatch", async () => {
    const res = await post({ airtimeAmount: 10, network: "MTN", expectedPay: "abc" })
    expect(res.status).toBe(409)
    expect(h.state.inserts).toHaveLength(0)
  })
})
