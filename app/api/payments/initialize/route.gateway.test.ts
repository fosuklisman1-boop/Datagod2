import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// payments/initialize choosing Paystack or Hubtel per surface (Plan 4 Task 4). Only server config decides the gateway;
// the wrappers in lib/payment-gateway/start.ts are replaced by spies here (their own behaviour is pinned in start.test.ts),
// while resolveSurfaceGateway runs for real against a mocked config.

type Surface = "wallet_topup" | "storefront" | "dashboard_direct" | "sms" | "ussd" | "whatsapp"

const h = vi.hoisted(() => {
  const surfaceCfg = (gateway = "paystack", mode = "checkout", feeBearer = "customer") => ({ gateway, mode, feeBearer })
  const state = {
    tables: {} as Record<string, any>,
    inserts: [] as { table: string; rows: any[] }[],
    updates: [] as { table: string; patch: any; filters: [string, unknown][] }[],
    /** wallet_payments rows returned to the Hubtel replay lookup (eq payment_method hubtel). */
    hubtelRows: [] as any[],
    /** Order of events, to prove the payment_method fix lands after the start and before the response. */
    events: [] as string[],
    gates: { storefrontOtp: false, storefrontDirect: false, walletOtp: false, walletDirect: false, dashboardDirect: false },
    otpVerified: true,
    authUser: null as { id: string } | null,
    ready: true,
    config: null as any,
    surfaceCfg,
    momoGateway: null as null | "paystack" | "hubtel",
    hostedGateway: null as null | "paystack" | "hubtel",
    hostedError: null as null | "try_again" | "already_processing",
    /** What a wallet_payments update answers; default one changed row. */
    updateResult: null as null | { data: any; error: any },
  }
  const chain = (table: string) => {
    const c: any = {}
    const filters: [string, unknown][] = []
    let mode: "select" | "insert" | "update" = "select"
    let patch: any = null
    for (const m of ["select", "or", "is", "in", "gte", "gt", "order"]) c[m] = () => c
    c.eq = (k: string, v: unknown) => (filters.push([k, v]), c)
    c.limit = () => {
      if (table === "wallet_payments" && mode === "select") {
        const hubtelLookup = filters.some(([k, v]) => k === "payment_method" && v === "hubtel")
        return Promise.resolve({ data: hubtelLookup ? state.hubtelRows : [], error: null })
      }
      return c
    }
    c.single = async () => {
      if (table === "subscription_plans") return { data: { price: 50 }, error: null }
      if (table === "user_shops") return { data: { id: "shop1" }, error: null }
      if (table === "app_settings") return { data: { paystack_fee_percentage: 3, wallet_topups_enabled: true, upgrades_enabled: true }, error: null }
      return { data: state.tables[table] ?? null, error: null }
    }
    c.maybeSingle = async () => ({ data: state.tables[table] ?? null, error: null })
    c.insert = (rows: any[]) => (mode = "insert", state.inserts.push({ table, rows }), c)
    c.update = (p: any) => (mode = "update", patch = p, c)
    c.then = (res: any, rej: any) => {
      if (mode === "update") {
        state.updates.push({ table, patch, filters })
        state.events.push(`update:${table}`)
        if (state.updateResult) return Promise.resolve(state.updateResult).then(res, rej)
      }
      return Promise.resolve({ data: [{ id: "wp1" }], error: null }).then(res, rej)
    }
    return c
  }
  return {
    state,
    fake: { from: chain, auth: { getUser: async () => ({ data: { user: state.authUser } }) } },
  }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
const chargeMobileMoney = vi.fn(async (_p: any) => ({ status: "pay_offline" }))
const initializePayment = vi.fn(async (_p: any) => ({ authorizationUrl: "https://paystack/x", accessCode: "ac", reference: "r" }))
vi.mock("@/lib/paystack", () => ({
  chargeMobileMoney: (p: any) => chargeMobileMoney(p),
  initializePayment: (p: any) => initializePayment(p),
}))

const startMomoCharge = vi.fn(async (surface: Surface, params: any) => {
  const gateway = h.state.momoGateway ?? (h.state.config.surfaces[surface].gateway === "hubtel" && params.verifiedPayer ? "hubtel" : "paystack")
  if (gateway === "paystack") {
    const { verifiedPayer, onFallback, ...p } = params
    void verifiedPayer
    const amount = onFallback ? (await onFallback()).amount : p.amount
    return { ...(await chargeMobileMoney({ ...p, amount })), reference: params.reference, gateway }
  }
  return { status: "pay_offline", reference: params.reference, gateway, hubtelReference: "h".repeat(32) }
})
const startHostedPayment = vi.fn(async (surface: Surface, params: any) => {
  if (h.state.hostedError) {
    const { HostedStartError } = await import("@/lib/payment-gateway/start")
    throw new HostedStartError(h.state.hostedError)
  }
  const gateway = h.state.hostedGateway ?? h.state.config.surfaces[surface].gateway
  if (gateway === "paystack") return { ...(await initializePayment(params)), gateway }
  return { authorizationUrl: "https://pay.hubtel.com/abc", accessCode: "", reference: params.reference, gateway }
})
vi.mock("@/lib/payment-gateway/start", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/payment-gateway/start")>()
  return {
    ...real,
    startMomoCharge: (s: Surface, p: any) => { h.state.events.push("start:momo"); return startMomoCharge(s, p) },
    startHostedPayment: (s: Surface, p: any) => { h.state.events.push("start:hosted"); return startHostedPayment(s, p) },
  }
})
vi.mock("@/lib/payment-gateway/read-config", () => ({
  getGatewayConfig: async () => h.state.config,
  getSurfaceConfig: async (s: Surface) => h.state.config.surfaces[s],
}))
vi.mock("@/lib/payment-gateway/hubtel-readiness", () => ({ isHubtelCollectionReady: () => h.state.ready }))
vi.mock("@/lib/shop-handle", () => ({ shopHandleOrFilter: () => "x" }))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() })) }))
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
const sendThrottledAlert = vi.fn(async (..._a: any[]) => {})
vi.mock("@/lib/hubtel-pay/alert-throttle", () => ({ sendThrottledAlert: (...a: any[]) => sendThrottledAlert(...a) }))

const closeRefused = vi.fn(async (..._a: any[]) => "closed" as const)
vi.mock("@/lib/payment-gateway/close-refused", () => ({ closeRefusedHubtelWalletPayment: (...a: any[]) => closeRefused(...a) }))

import * as route from "./route"
const { POST } = route

const ORDER_ID = "11111111-2222-3333-4444-555555555555"
const PLAN_ID = "4d05cda6-4e1b-42ec-841d-f4c9a41fb79b"

function config(over: Partial<Record<Surface, ReturnType<typeof h.state.surfaceCfg>>> = {}) {
  const all: Surface[] = ["wallet_topup", "storefront", "dashboard_direct", "sms", "ussd", "whatsapp"]
  const surfaces = Object.fromEntries(all.map((s) => [s, h.state.surfaceCfg()])) as Record<Surface, any>
  return { version: 1, surfaces: { ...surfaces, ...over }, hubtelFeePercent: 1.95 }
}

const send = (body: Record<string, unknown>, auth = true) =>
  POST(new NextRequest("http://x/api/payments/initialize", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { Authorization: "Bearer tok" } : {}) },
    body: JSON.stringify(body),
  }))
const topup = (body: Record<string, unknown> = {}) => send({ email: "dealer@example.com", amount: 50, ...body })
const momoTopup = (body: Record<string, unknown> = {}) => topup({ momoDirect: true, paymentPhone: "0241234567", ...body })
const shopOrder = (body: Record<string, unknown> = {}) =>
  send({ orderId: ORDER_ID, shopSlug: "myshop", email: "buyer@example.com", amount: 1, ...body }, false)

const walletRow = () => h.state.inserts.find((i) => i.table === "wallet_payments")?.rows[0]
const methodUpdates = () => h.state.updates.filter((u) => u.table === "wallet_payments" && "payment_method" in u.patch)

beforeEach(() => {
  h.state.tables = {
    shop_orders: { total_price: 20, order_status: "pending", payment_status: "pending", customer_phone: "0241234567" },
    results_check_requests: { fee: 10, status: "pending", payment_status: "unpaid", phone_number: "0241234567" },
    users: { role: "user", phone_number: null, phone_verified: false },
  }
  h.state.inserts = []
  h.state.updates = []
  h.state.hubtelRows = []
  h.state.events = []
  h.state.gates = { storefrontOtp: false, storefrontDirect: false, walletOtp: false, walletDirect: false, dashboardDirect: false }
  h.state.otpVerified = true
  h.state.authUser = { id: "user1" }
  h.state.ready = true
  h.state.config = config()
  h.state.momoGateway = null
  h.state.hostedGateway = null
  h.state.hostedError = null
  h.state.updateResult = null
  sendThrottledAlert.mockClear()
  chargeMobileMoney.mockClear()
  initializePayment.mockClear()
  startMomoCharge.mockClear()
  startHostedPayment.mockClear()
  closeRefused.mockClear()
})

describe("payments/initialize gateway choice", () => {
  it("sets maxDuration = 60 (a Hubtel start awaits the relay)", () => {
    expect((route as { maxDuration?: number }).maxDuration).toBe(60)
  })

  it("Hubtel top-up (direct): fee 0, payment_method hubtel, amount = price, wallet reference passed to the wrapper", async () => {
    h.state.config = config({ wallet_topup: h.state.surfaceCfg("hubtel", "direct") })
    h.state.gates.walletDirect = true
    const res = await momoTopup()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, momoDirect: true, status: "pay_offline" })
    expect(json.status).not.toBe("send_otp")
    expect(walletRow()).toMatchObject({ amount: 50, fee: 0, payment_method: "hubtel", order_type: "data" })
    expect(startMomoCharge).toHaveBeenCalledTimes(1)
    const [surface, params] = startMomoCharge.mock.calls[0]
    expect(surface).toBe("wallet_topup")
    expect(params).toMatchObject({ amount: 50, phone: "0241234567", provider: "mtn", verifiedPayer: true })
    expect(params.reference).toBeTruthy()
    expect(params.reference).toBe(walletRow().reference)
    expect(params.metadata).toMatchObject({ paystackFee: 0, originalAmount: 50 })
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(methodUpdates()).toHaveLength(0)
  })

  it("Hubtel top-up (hosted): fee 0, payment_method hubtel, Hubtel's link returned", async () => {
    h.state.config = config({ wallet_topup: h.state.surfaceCfg("hubtel", "checkout") })
    const res = await topup()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ authorizationUrl: "https://pay.hubtel.com/abc" })
    expect(walletRow()).toMatchObject({ amount: 50, fee: 0, payment_method: "hubtel" })
    const [surface, params] = startHostedPayment.mock.calls[0]
    expect(surface).toBe("wallet_topup")
    expect(params.reference).toBeTruthy()
    expect(params.reference).toBe(walletRow().reference)
    expect(params.amount).toBe(50)
  })

  it("Paystack config: today's fee, payment_method paystack, Paystack charged with the total", async () => {
    h.state.gates.walletDirect = true
    await momoTopup()
    expect(walletRow()).toMatchObject({ amount: 51.5, fee: 1.5, payment_method: "paystack" })
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(chargeMobileMoney.mock.calls[0][0]).toMatchObject({ amount: 51.5 })
    expect(chargeMobileMoney.mock.calls[0][0]).not.toHaveProperty("verifiedPayer")
  })

  it("client-supplied gateway / mode / feeBearer are ignored, both ways", async () => {
    h.state.gates.walletDirect = true
    await momoTopup({ gateway: "hubtel", mode: "direct", feeBearer: "merchant" })
    expect(walletRow()).toMatchObject({ payment_method: "paystack", fee: 1.5 })
    expect(startMomoCharge.mock.calls[0][1].verifiedPayer).toBe(false)

    h.state.inserts = []
    h.state.config = config({ wallet_topup: h.state.surfaceCfg("hubtel", "direct") })
    await momoTopup({ gateway: "paystack", mode: "checkout" })
    expect(walletRow()).toMatchObject({ payment_method: "hubtel", fee: 0 })
  })

  it("merchant bearer on Paystack: fee 0, amount = price", async () => {
    h.state.config = config({ wallet_topup: h.state.surfaceCfg("paystack", "checkout", "merchant") })
    await topup()
    expect(walletRow()).toMatchObject({ amount: 50, fee: 0, payment_method: "paystack" })
    expect(initializePayment.mock.calls[0][0].amount).toBe(50)
  })

  it("unverified number on Hubtel direct => today's OTP-required answer, even with the OTP gate off; nothing written or sent", async () => {
    h.state.config = config({ wallet_topup: h.state.surfaceCfg("hubtel", "direct") })
    h.state.gates.walletDirect = true
    h.state.gates.walletOtp = false
    h.state.otpVerified = false
    const res = await momoTopup()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Please verify your payment number to continue.", code: "OTP_REQUIRED" })
    expect(walletRow()).toBeUndefined()
    expect(startMomoCharge).not.toHaveBeenCalled()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("the logged-in user's own verified number counts as verified on Hubtel direct", async () => {
    h.state.config = config({ wallet_topup: h.state.surfaceCfg("hubtel", "direct") })
    h.state.gates.walletDirect = true
    h.state.otpVerified = false
    h.state.tables.users = { role: "user", phone_number: "233241234567", phone_verified: true }
    const res = await momoTopup()
    expect(res.status).toBe(200)
    expect(walletRow()).toMatchObject({ payment_method: "hubtel" })

    // ...but not when the account's number is unverified, or is a different number
    h.state.inserts = []
    h.state.tables.users = { role: "user", phone_number: "0241234567", phone_verified: false }
    expect((await momoTopup()).status).toBe(403)
    h.state.tables.users = { role: "user", phone_number: "0559999999", phone_verified: true }
    expect((await momoTopup()).status).toBe(403)
  })

  it("Hubtel not ready => Paystack with today's fee (no OTP demand)", async () => {
    h.state.config = config({ wallet_topup: h.state.surfaceCfg("hubtel", "direct") })
    h.state.gates.walletDirect = true
    h.state.ready = false
    h.state.otpVerified = false
    const res = await momoTopup()
    expect(res.status).toBe(200)
    expect(walletRow()).toMatchObject({ payment_method: "paystack", fee: 1.5 })
  })

  it("fallback: Hubtel resolved but the wrapper used Paystack => one update sets amount, fee and method; Paystack charges price + fee", async () => {
    h.state.config = config({ wallet_topup: h.state.surfaceCfg("hubtel", "direct") })
    h.state.gates.walletDirect = true
    h.state.momoGateway = "paystack"
    const res = await momoTopup()
    expect(res.status).toBe(200)
    const wp = walletRow()
    expect(wp).toMatchObject({ payment_method: "hubtel", fee: 0, amount: 50 })
    const ups = methodUpdates()
    expect(ups).toHaveLength(1)
    expect(ups[0].patch).toEqual({ amount: 51.5, fee: 1.5, payment_method: "paystack" })
    expect(ups[0].filters).toContainEqual(["reference", wp.reference])
    expect(chargeMobileMoney.mock.calls[0][0]).toMatchObject({ amount: 51.5 })
  })

  it("fallback on a merchant-bearing surface: Paystack + merchant bearer stays fee 0", async () => {
    h.state.config = config({ wallet_topup: h.state.surfaceCfg("hubtel", "direct", "merchant") })
    h.state.gates.walletDirect = true
    h.state.momoGateway = "paystack"
    await momoTopup()
    expect(methodUpdates()[0].patch).toEqual({ amount: 50, fee: 0, payment_method: "paystack" })
    expect(chargeMobileMoney.mock.calls[0][0]).toMatchObject({ amount: 50 })
  })

  it("other direction: Paystack resolved but the hosted wrapper used Hubtel => row fixed to hubtel", async () => {
    h.state.hostedGateway = "hubtel"
    await topup()
    expect(walletRow()).toMatchObject({ payment_method: "paystack" })
    const ups = methodUpdates()
    expect(ups).toHaveLength(1)
    expect(ups[0].patch).toEqual({ payment_method: "hubtel" })
    expect(ups[0].filters).toContainEqual(["reference", walletRow().reference])
    expect(sendThrottledAlert).not.toHaveBeenCalled()
  })

  it("a failed payment_method correction sends a throttled alert: on an error, and when no row changed", async () => {
    h.state.hostedGateway = "hubtel"
    h.state.updateResult = { data: null, error: { message: "db down" } }
    expect((await topup()).status).toBe(200)
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1)
    h.state.updateResult = { data: [], error: null }
    expect((await topup()).status).toBe(200)
    expect(sendThrottledAlert).toHaveBeenCalledTimes(2)
  })

  it("a hosted start error answers the wrapper's message; already_processing is 409, try_again 503", async () => {
    h.state.config = config({ wallet_topup: h.state.surfaceCfg("hubtel", "checkout") })
    h.state.hostedError = "try_again"
    let res = await topup()
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe("We couldn't open the payment page. Please try again in a few minutes.")
    h.state.hostedError = "already_processing"
    res = await topup()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("This payment is already being processed. Please check your order before paying again.")
  })

  it("a refused start closes its own fresh Hubtel row (hosted error, momo fallback refused); success and replays don't", async () => {
    h.state.config = config({ wallet_topup: h.state.surfaceCfg("hubtel", "checkout") })
    h.state.hostedError = "already_processing"
    await topup()
    expect(closeRefused).toHaveBeenCalledTimes(1)
    expect(closeRefused.mock.calls[0][1]).toBe(walletRow().reference)

    closeRefused.mockClear()
    h.state.hostedError = "try_again"
    await topup()
    expect(closeRefused).toHaveBeenCalledTimes(1)

    closeRefused.mockClear()
    h.state.hostedError = null
    expect((await topup()).status).toBe(200)
    expect(closeRefused).not.toHaveBeenCalled()

    // A fallback that can't re-price throws FallbackRefusedError: nothing was charged.
    h.state.config = config({ wallet_topup: h.state.surfaceCfg("hubtel", "direct") })
    h.state.gates.walletDirect = true
    h.state.momoGateway = "paystack"
    h.state.updateResult = { data: [], error: null }
    expect((await momoTopup()).status).toBe(503)
    expect(closeRefused).toHaveBeenCalledTimes(1)
  })

  it("hosted with direct charge on (MoMo stripped on Paystack): stays on Paystack, never a Hubtel page", async () => {
    h.state.config = config({ wallet_topup: h.state.surfaceCfg("hubtel", "direct") })
    h.state.gates.walletDirect = true
    await topup()
    expect(startHostedPayment).not.toHaveBeenCalled()
    expect(initializePayment).toHaveBeenCalledTimes(1)
    expect(initializePayment.mock.calls[0][0].channels).not.toContain("mobile_money")
    expect(walletRow()).toMatchObject({ payment_method: "paystack", fee: 1.5 })
  })
})

describe("payments/initialize surface mapping", () => {
  it("dealer upgrade => dashboard_direct", async () => {
    h.state.config = config({ dashboard_direct: h.state.surfaceCfg("hubtel", "checkout") })
    await send({ type: "dealer_upgrade", planId: PLAN_ID, email: "dealer@example.com", amount: 1 })
    expect(startHostedPayment.mock.calls[0][0]).toBe("dashboard_direct")
    expect(walletRow()).toMatchObject({ order_type: "dealer_upgrade", amount: 50, fee: 0, payment_method: "hubtel" })
  })

  it("results-check service => dashboard_direct", async () => {
    h.state.config = config({ dashboard_direct: h.state.surfaceCfg("hubtel", "checkout") })
    await send({ orderId: ORDER_ID, orderType: "results_check_service", email: "c@example.com", amount: 1 }, false)
    expect(startHostedPayment.mock.calls[0][0]).toBe("dashboard_direct")
    expect(walletRow()).toMatchObject({ order_type: "results_check_service", amount: 10, fee: 0, payment_method: "hubtel" })
  })

  it("shop order => storefront", async () => {
    h.state.config = config({ storefront: h.state.surfaceCfg("hubtel", "checkout") })
    const res = await shopOrder()
    expect(res.status).toBe(200)
    expect(startHostedPayment.mock.calls[0][0]).toBe("storefront")
    expect(walletRow()).toMatchObject({ order_id: ORDER_ID, amount: 20, fee: 0, payment_method: "hubtel" })
  })

  it("R1: a shop order that is no longer payable is refused before any gateway start", async () => {
    h.state.config = config({ storefront: h.state.surfaceCfg("hubtel", "checkout") })
    h.state.tables.shop_orders = { ...h.state.tables.shop_orders, order_status: "failed" }
    const res = await shopOrder()
    expect(res.status).toBe(400)
    expect(startHostedPayment).not.toHaveBeenCalled()
    expect(walletRow()).toBeUndefined()
  })
})

describe("payments/initialize R2: replay a live Hubtel attempt for the same order", () => {
  const fresh = () => new Date(Date.now() - 2 * 60_000).toISOString()

  it("Hubtel resolved + a fresh pending Hubtel row => its reference is reused, no new payment row", async () => {
    h.state.config = config({ storefront: h.state.surfaceCfg("hubtel", "checkout") })
    h.state.hubtelRows = [{ id: "wp-old", reference: "WALLET-OLD", payment_method: "hubtel", status: "pending", created_at: fresh() }]
    const res = await shopOrder()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ reference: "WALLET-OLD", paymentId: "wp-old" })
    expect(startHostedPayment.mock.calls[0][1].reference).toBe("WALLET-OLD")
    expect(walletRow()).toBeUndefined()
  })

  it("Paystack resolved + a fresh pending Hubtel row => 409 PAYMENT_IN_PROGRESS, nothing started", async () => {
    h.state.hubtelRows = [{ id: "wp-old", reference: "WALLET-OLD", payment_method: "hubtel", status: "pending", created_at: fresh() }]
    const res = await shopOrder()
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "PAYMENT_IN_PROGRESS" })
    expect(startHostedPayment).not.toHaveBeenCalled()
    expect(initializePayment).not.toHaveBeenCalled()
    expect(walletRow()).toBeUndefined()
  })

  it("a stale Hubtel row (over 15 minutes) is not replayed: a new reference is minted", async () => {
    h.state.config = config({ storefront: h.state.surfaceCfg("hubtel", "checkout") })
    h.state.hubtelRows = [{ id: "wp-old", reference: "WALLET-OLD", payment_method: "hubtel", status: "pending", created_at: new Date(Date.now() - 16 * 60_000).toISOString() }]
    await shopOrder()
    expect(walletRow().reference).not.toBe("WALLET-OLD")
    expect(startHostedPayment.mock.calls[0][1].reference).toBe(walletRow().reference)
  })
})

describe("payments/initialize: requests with no surface keep today's path", () => {
  it("a bot commission row never goes through the wrappers", async () => {
    h.state.config = config({ storefront: h.state.surfaceCfg("hubtel", "checkout") })
    h.state.tables.hubtel_bill_orders = {
      channel: "bots", shop_id: null, status: "pending", payment_status: "unpaid", paid_amount: 10.11, buyer_email: null, buyer_phone: "233241234567",
    }
    const res = await send({ orderId: ORDER_ID, orderType: "cs_bill", amount: 1 }, false)
    expect(res.status).toBe(200)
    expect(startHostedPayment).not.toHaveBeenCalled()
    expect(initializePayment).toHaveBeenCalledTimes(1)
    expect(walletRow()).toMatchObject({ payment_method: "paystack", fee: 0, amount: 10.11 })
  })
})
