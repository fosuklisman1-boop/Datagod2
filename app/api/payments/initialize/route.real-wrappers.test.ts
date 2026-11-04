import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// payments/initialize with the REAL wrappers from lib/payment-gateway/start.ts over an in-memory database. Only the
// network edges are fakes: Paystack, Hubtel's relay calls, and the config read. route.gateway.test.ts spies on the
// wrappers, which is how a fee-0 Paystack charge got past it; this file is what pins money through both layers.

const h = vi.hoisted(() => {
  type Row = Record<string, any>
  const state = {
    db: {} as Record<string, Row[]>,
    config: null as any,
    ready: true,
    otpVerified: true,
    authUser: null as { id: string } | null,
    gates: { storefrontOtp: false, storefrontDirect: false, walletOtp: false, walletDirect: false, dashboardDirect: false },
    /** Answer to the next wallet_payments updates, instead of applying them. */
    walletUpdateError: null as null | { message: string },
    capped: [] as string[],
    nextId: 1,
  }
  const OPEN = ["pending", "confirming"]
  const query = (table: string) => {
    const rows = () => (state.db[table] ??= [])
    const filters: ((r: Row) => boolean)[] = []
    let mode: "select" | "insert" | "update" = "select"
    let patch: Row = {}
    let inserted: Row[] = []
    let error: any = null
    const matching = () => rows().filter((r) => filters.every((f) => f(r)))
    const run = () => {
      if (mode === "insert") return { data: error ? null : inserted, error }
      if (mode === "update") {
        if (table === "wallet_payments" && state.walletUpdateError) return { data: null, error: state.walletUpdateError }
        const hit = matching()
        hit.forEach((r) => Object.assign(r, patch))
        return { data: hit, error: null }
      }
      return { data: matching(), error: null }
    }
    const c: any = {}
    for (const m of ["select", "or", "is", "gt", "order"]) c[m] = () => c
    c.eq = (k: string, v: unknown) => (filters.push((r) => r[k] === v), c)
    c.in = (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), c)
    c.gte = (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), c)
    c.limit = () => c
    c.insert = (input: Row | Row[]) => {
      mode = "insert"
      inserted = (Array.isArray(input) ? input : [input]).map((r) => ({ id: `row${state.nextId++}`, status: "pending", ...r }))
      // The partial unique index on open attempts.
      if (table === "hubtel_payments" && inserted.some((n) => rows().some((r) => r.internal_reference === n.internal_reference && OPEN.includes(r.status)))) {
        error = { code: "23505", message: "duplicate" }
      } else {
        rows().push(...inserted)
      }
      return c
    }
    c.update = (p: Row) => (mode = "update", patch = p, c)
    c.single = async () => {
      const { data, error: e } = run()
      return { data: data?.[0] ?? null, error: e ?? (data?.[0] ? null : { message: "no rows" }) }
    }
    c.maybeSingle = async () => {
      const { data, error: e } = run()
      return { data: data?.[0] ?? null, error: e }
    }
    c.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
    return c
  }
  const fake = {
    from: query,
    auth: { getUser: async () => ({ data: { user: state.authUser } }) },
    rpc: async (_fn: string, args: { p_reference: string }) => {
      const r = (state.db.hubtel_payments ?? []).find((x) => x.reference === args.p_reference && x.status === "pending")
      if (!r) return { data: [], error: null }
      r.status = "confirming"
      r.claimed_at = "claimed"
      return { data: [{ reference: r.reference, claimed_at: r.claimed_at }], error: null }
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
const chargeMobileMoney = vi.fn(async (p: any) => ({ status: "pay_offline", reference: p.reference }))
const initializePayment = vi.fn(async (p: any) => ({ authorizationUrl: "https://paystack/x", accessCode: "ac", reference: p.reference }))
vi.mock("@/lib/paystack", () => ({
  chargeMobileMoney: (p: any) => chargeMobileMoney(p),
  initializePayment: (p: any) => initializePayment(p),
}))
const receiveMoney = vi.fn(async (_p: any): Promise<any> => ({ kind: "accepted" }))
const initiateCheckout = vi.fn(async (_p: any): Promise<any> => ({ kind: "accepted", checkoutUrl: "https://pay.hubtel.com/abc" }))
vi.mock("@/lib/hubtel-pay/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hubtel-pay/client")>()),
  receiveMoney: (p: any) => receiveMoney(p),
  initiateCheckout: (p: any) => initiateCheckout(p),
  checkPaymentStatus: async () => ({ kind: "not_found", raw: {} }),
  hubtelCallbackUrl: (r: string) => `https://www.example.com/cb?ref=${r}`,
  hubtelReturnUrl: (r: string) => `https://www.example.com/rt?ref=${r}`,
}))
vi.mock("@/lib/hubtel-pay/alert-throttle", () => ({ sendThrottledAlert: vi.fn(async () => {}) }))
vi.mock("@/lib/payment-gateway/read-config", () => ({ getGatewayConfig: async () => h.state.config }))
vi.mock("@/lib/payment-gateway/hubtel-readiness", () => ({ isHubtelCollectionReady: () => h.state.ready }))
vi.mock("@/lib/shop-handle", () => ({ shopHandleOrFilter: () => "x" }))
vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: vi.fn(async (_r: unknown, name: string) => ({ allowed: !h.state.capped.includes(name), resetAt: Date.now() })),
}))
vi.mock("@/lib/shop-token", () => ({ verifyShopSession: () => ({ valid: true }) }))
vi.mock("@/lib/storefront-otp", () => ({
  isPhoneOtpVerified: async () => h.state.otpVerified,
  isWalletOtpRequired: async () => h.state.gates.walletOtp,
  isStorefrontOtpRequired: async () => h.state.gates.storefrontOtp,
  isStorefrontDirectChargeEnabled: async () => h.state.gates.storefrontDirect,
  isWalletDirectChargeEnabled: async () => h.state.gates.walletDirect,
  isDashboardDirectChargeEnabled: async () => h.state.gates.dashboardDirect,
}))
vi.mock("@/lib/security-log", () => ({ logSecurityEvent: vi.fn() }))
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified: async () => ({ allowed: true }) }))
vi.mock("@/lib/custom-domain-lookup", () => ({ resolveTrustedBaseUrl: async () => "https://shop.example" }))
vi.mock("@/lib/refunds/payer-phone", () => ({ recordPayerPhone: vi.fn(async () => {}) }))

import { POST } from "./route"
import { applyRateLimit } from "@/lib/rate-limiter"

const ORDER_ID = "11111111-2222-3333-4444-555555555555"
const PLAN_ID = "4d05cda6-4e1b-42ec-841d-f4c9a41fb79b"
type Surface = "wallet_topup" | "storefront" | "dashboard_direct" | "sms" | "ussd" | "whatsapp"

function config(hubtel: Partial<Record<Surface, { mode?: string; feeBearer?: string }>> = {}) {
  const all: Surface[] = ["wallet_topup", "storefront", "dashboard_direct", "sms", "ussd", "whatsapp"]
  const surfaces: Record<string, any> = {}
  for (const s of all) {
    const over = hubtel[s]
    surfaces[s] = over
      ? { gateway: "hubtel", mode: over.mode ?? "direct", feeBearer: over.feeBearer ?? "customer" }
      : { gateway: "paystack", mode: "checkout", feeBearer: "customer" }
  }
  return { version: 1, surfaces, hubtelFeePercent: 0 }
}

const send = (body: Record<string, unknown>, auth = true) =>
  POST(new NextRequest("http://x/api/payments/initialize", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { Authorization: "Bearer tok" } : {}) },
    body: JSON.stringify(body),
  }))
const topup = (body: Record<string, unknown> = {}) => send({ email: "dealer@example.com", amount: 50, ...body })
const momoTopup = (paymentPhone: string, body: Record<string, unknown> = {}) => topup({ momoDirect: true, paymentPhone, ...body })
const shopOrder = (body: Record<string, unknown> = {}) =>
  send({ orderId: ORDER_ID, shopSlug: "myshop", email: "buyer@example.com", amount: 1, ...body }, false)

const walletRows = () => h.state.db.wallet_payments ?? []
const hubtelRows = () => h.state.db.hubtel_payments ?? []
const REFUSED = { kind: "refused", code: "4000", message: "no" }

beforeEach(() => {
  h.state.db = {
    user_shops: [{ id: "shop1", is_active: true, shop_slug: "myshop" }],
    app_settings: [{ paystack_fee_percentage: 3, wallet_topups_enabled: true, upgrades_enabled: true }],
    users: [{ id: "user1", role: "user", phone_number: null, phone_verified: false }],
    subscription_plans: [{ id: PLAN_ID, price: 50, is_active: true }],
    shop_orders: [{ id: ORDER_ID, total_price: 20, order_status: "pending", payment_status: "pending", customer_phone: "0241234567" }],
    results_checker_orders: [{ id: ORDER_ID, total_paid: 10, status: "pending", payment_status: "pending", customer_phone: "0241234567" }],
    results_check_requests: [{ id: ORDER_ID, fee: 10, status: "pending", payment_status: "unpaid", phone_number: "0241234567" }],
  }
  h.state.config = config()
  h.state.ready = true
  h.state.otpVerified = true
  h.state.authUser = { id: "user1" }
  h.state.gates = { storefrontOtp: false, storefrontDirect: false, walletOtp: false, walletDirect: false, dashboardDirect: false }
  h.state.walletUpdateError = null
  h.state.capped = []
  vi.mocked(applyRateLimit).mockClear()
  chargeMobileMoney.mockClear()
  initializePayment.mockClear()
  receiveMoney.mockReset()
  receiveMoney.mockImplementation(async () => ({ kind: "accepted" }))
  initiateCheckout.mockReset()
  initiateCheckout.mockImplementation(async () => ({ kind: "accepted", checkoutUrl: "https://pay.hubtel.com/abc" }))
})

describe("formatted phone numbers on a Hubtel direct surface: never fee 0 on Paystack", () => {
  beforeEach(() => {
    h.state.config = config({ wallet_topup: { mode: "direct" } })
    h.state.gates.walletDirect = true
  })

  it.each(["0241234567", "024 123 4567", "024-123-4567", "(024)1234567", "241234567", "+233 24 123 4567", "233-24-123-4567", "0241234567x"])(
    "%s => Hubtel with the canonical number, fee 0",
    async (phone) => {
      const res = await momoTopup(phone)
      expect(res.status).toBe(200)
      expect(receiveMoney).toHaveBeenCalledTimes(1)
      expect(receiveMoney.mock.calls[0][0]).toMatchObject({ msisdn: "233241234567", channel: "mtn-gh", amount: 50 })
      expect(chargeMobileMoney).not.toHaveBeenCalled()
      expect(walletRows()[0]).toMatchObject({ amount: 50, fee: 0, payment_method: "hubtel" })
    },
  )

  it("a number with no canonical form => Paystack at the full fee from the start, raw value kept", async () => {
    const res = await momoTopup("024123456")
    expect(res.status).toBe(200)
    expect(receiveMoney).not.toHaveBeenCalled()
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(chargeMobileMoney.mock.calls[0][0]).toMatchObject({ amount: 51.5, phone: "024123456" })
    expect(walletRows()[0]).toMatchObject({ amount: 51.5, fee: 1.5, payment_method: "paystack" })
  })
})

describe("a retry during an open Hubtel attempt: one prompt", () => {
  beforeEach(() => {
    h.state.config = config({ storefront: { mode: "direct" } })
    h.state.gates.storefrontDirect = true
  })

  it.each(["024 123 4567", "+233 24 123 4567", "241234567", "0241234567x"])("retry with %s => no second prompt on any gateway", async (phone) => {
    const first = await shopOrder({ momoDirect: true, paymentPhone: "0241234567" })
    expect(first.status).toBe(200)
    const firstRef = (await first.json()).reference
    const retry = await shopOrder({ momoDirect: true, paymentPhone: phone })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ reference: firstRef, status: "pay_offline" })
    expect(receiveMoney).toHaveBeenCalledTimes(1)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(walletRows()).toHaveLength(1)
    expect(hubtelRows()).toHaveLength(1)
  })

  it("retry with a number that has no canonical form => 409, no Paystack prompt", async () => {
    await shopOrder({ momoDirect: true, paymentPhone: "0241234567" })
    const retry = await shopOrder({ momoDirect: true, paymentPhone: "024123456" })
    expect(retry.status).toBe(409)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(receiveMoney).toHaveBeenCalledTimes(1)
  })
})

describe("fallback to Paystack after a Hubtel refusal: the customer pays price + fee, and the row says so", () => {
  it("direct", async () => {
    h.state.config = config({ wallet_topup: { mode: "direct" } })
    h.state.gates.walletDirect = true
    receiveMoney.mockImplementation(async () => REFUSED)
    const res = await momoTopup("024 123 4567")
    expect(res.status).toBe(200)
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
    const sent = chargeMobileMoney.mock.calls[0][0] as any
    expect(sent.amount).toBe(51.5)
    expect(sent.metadata).toMatchObject({ paystackFee: 1.5, originalAmount: 50 })
    expect(walletRows()).toHaveLength(1)
    expect(walletRows()[0]).toMatchObject({ amount: 51.5, fee: 1.5, payment_method: "paystack", status: "pending" })
    expect(hubtelRows()[0].status).toBe("failed")
  })

  it("hosted, and payment_attempts carries the corrected fee", async () => {
    h.state.config = config({ wallet_topup: { mode: "checkout" } })
    initiateCheckout.mockImplementation(async () => REFUSED)
    const res = await topup()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ authorizationUrl: "https://paystack/x" })
    expect((initializePayment.mock.calls[0][0] as any).amount).toBe(51.5)
    expect(walletRows()[0]).toMatchObject({ amount: 51.5, fee: 1.5, payment_method: "paystack" })
    await vi.waitFor(() => expect(h.state.db.payment_attempts?.[0]).toMatchObject({ amount: 50, fee: 1.5 }))
    expect(hubtelRows()[0].status).toBe("failed")
  })

  it.each<[string, () => void]>([
    ["the update errors", () => { h.state.walletUpdateError = { message: "db down" } }],
    ["no row changed", () => { walletRows()[0].status = "failed" }],
  ])("direct: %s => 503 try again, nothing charged, Hubtel row closed", async (_n, breakIt) => {
    h.state.config = config({ wallet_topup: { mode: "direct" } })
    h.state.gates.walletDirect = true
    receiveMoney.mockImplementation(async () => { breakIt(); return REFUSED })
    const res = await momoTopup("0241234567")
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/try again/i)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(hubtelRows()[0].status).toBe("failed")
  })

  it("hosted: the update errors => 503 try again, nothing started", async () => {
    h.state.config = config({ wallet_topup: { mode: "checkout" } })
    initiateCheckout.mockImplementation(async () => { h.state.walletUpdateError = { message: "db down" }; return REFUSED })
    const res = await topup()
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/try again/i)
    expect(initializePayment).not.toHaveBeenCalled()
    expect(hubtelRows()[0].status).toBe("failed")
  })
})

describe("the per-phone cap on Hubtel direct", () => {
  beforeEach(() => {
    h.state.config = config({ wallet_topup: { mode: "direct" } })
    h.state.gates.walletDirect = true
  })
  const phoneCapKeys = () => vi.mocked(applyRateLimit).mock.calls.filter((c) => c[1] === "momodirect_phone").map((c) => c[4])

  it("applies with the OTP gate on, once, keyed on the canonical number", async () => {
    h.state.gates.walletOtp = true
    expect((await momoTopup("+233 24 123 4567")).status).toBe(200)
    expect(phoneCapKeys()).toEqual(["mp:0241234567"])
  })

  it("applies with the OTP gate off, once", async () => {
    expect((await momoTopup("024 123 4567")).status).toBe(200)
    expect(phoneCapKeys()).toEqual(["mp:0241234567"])
  })

  it("over the cap => 429 and nothing written or sent", async () => {
    h.state.gates.walletOtp = true
    h.state.capped = ["momodirect_phone"]
    expect((await momoTopup("0241234567")).status).toBe(429)
    expect(walletRows()).toHaveLength(0)
    expect(receiveMoney).not.toHaveBeenCalled()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("OTP gate on: the user's own verified number that never passed OTP => 403 with no row left behind", async () => {
    h.state.gates.walletOtp = true
    h.state.otpVerified = false
    h.state.db.users[0] = { id: "user1", role: "user", phone_number: "0241234567", phone_verified: true }
    expect((await momoTopup("0241234567")).status).toBe(403)
    expect(walletRows()).toHaveLength(0)
  })
})

describe("every surface on Paystack: unchanged, through the real wrappers", () => {
  const surfaces: { name: string; body: Record<string, unknown>; auth: boolean; gate: "walletDirect" | "storefrontDirect" | "dashboardDirect"; price: number; fee: number; channel: string; purpose: string; orderType: string }[] = [
    { name: "wallet top-up", body: { email: "d@example.com", amount: 50 }, auth: true, gate: "walletDirect", price: 50, fee: 1.5, channel: "wallet_topup", purpose: "Wallet Top-up", orderType: "data" },
    { name: "data shop order", body: { orderId: ORDER_ID, shopSlug: "myshop", email: "b@example.com", amount: 1 }, auth: false, gate: "storefrontDirect", price: 20, fee: 0.6, channel: "shop_data", purpose: "Data bundle", orderType: "data" },
    { name: "results checker", body: { orderId: ORDER_ID, shopSlug: "myshop", orderType: "results_checker", email: "b@example.com", amount: 1 }, auth: false, gate: "storefrontDirect", price: 10, fee: 0.3, channel: "shop_results_checker", purpose: "Results Checker voucher", orderType: "results_checker" },
    { name: "results-check service", body: { orderId: ORDER_ID, shopSlug: "myshop", orderType: "results_check_service", email: "b@example.com", amount: 1 }, auth: false, gate: "storefrontDirect", price: 10, fee: 0.3, channel: "shop_results_check", purpose: "Results Check Service", orderType: "results_check_service" },
    { name: "dealer upgrade", body: { type: "dealer_upgrade", planId: PLAN_ID, email: "d@example.com", amount: 1 }, auth: true, gate: "dashboardDirect", price: 50, fee: 1.5, channel: "dealer_upgrade", purpose: "Dealer Upgrade", orderType: "dealer_upgrade" },
  ]

  it.each(surfaces)("$name, hosted", async (s) => {
    const res = await send(s.body, s.auth)
    expect(res.status).toBe(200)
    const row = walletRows()[0]
    expect(row).toMatchObject({ amount: s.price + s.fee, fee: s.fee, payment_method: "paystack", status: "pending", order_type: s.orderType })
    expect(initializePayment).toHaveBeenCalledTimes(1)
    const p = initializePayment.mock.calls[0][0] as any
    expect(p).toMatchObject({ amount: s.price + s.fee, reference: row.reference, channel: s.channel, purpose: s.purpose, channels: ["card", "mobile_money", "bank_transfer"] })
    expect(p.metadata).toMatchObject({ paystackFee: s.fee, originalAmount: s.price })
    expect(p).not.toHaveProperty("onFallback")
    expect(await res.json()).toEqual({ success: true, authorizationUrl: "https://paystack/x", accessCode: "ac", reference: row.reference, paymentId: row.id })
    expect(hubtelRows()).toHaveLength(0)
    expect(receiveMoney).not.toHaveBeenCalled()
    expect(initiateCheckout).not.toHaveBeenCalled()
  })

  it.each(surfaces)("$name, direct: the raw number goes to Paystack as typed", async (s) => {
    h.state.gates[s.gate] = true
    const res = await send({ ...s.body, momoDirect: true, paymentPhone: "024 123 4567" }, s.auth)
    expect(res.status).toBe(200)
    const row = walletRows()[0]
    expect(row).toMatchObject({ amount: s.price + s.fee, fee: s.fee, payment_method: "paystack", status: "pending", order_type: s.orderType })
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
    const p = chargeMobileMoney.mock.calls[0][0] as any
    expect(p).toMatchObject({ amount: s.price + s.fee, reference: row.reference, phone: "024 123 4567", provider: "mtn", channel: s.channel, purpose: s.purpose })
    expect(p).not.toHaveProperty("channels")
    expect(p).not.toHaveProperty("verifiedPayer")
    expect(p).not.toHaveProperty("onFallback")
    expect(await res.json()).toEqual({ success: true, momoDirect: true, reference: row.reference, status: "pay_offline", paymentId: row.id })
    expect(hubtelRows()).toHaveLength(0)
    expect(receiveMoney).not.toHaveBeenCalled()
    const phoneCaps = vi.mocked(applyRateLimit).mock.calls.filter((c) => c[1] === "momodirect_phone").map((c) => c[4])
    expect(phoneCaps).toEqual(["mp:0241234567"])
  })
})
