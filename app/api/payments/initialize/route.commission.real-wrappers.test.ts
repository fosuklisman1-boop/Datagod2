import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Storefront commission orders through payments/initialize with the REAL wrappers, and through the REAL confirm path
// (confirmHubtelPayment -> handleChargeSuccess -> settleStorefrontWebhook -> confirmCommissionOrder). paid_amount is set
// at order creation with the Paystack fee inside it, and confirm checks it to the pesewa, so the amount charged and
// paid_amount have to change together. Also the results-check service, whose only start is this route.

const h = vi.hoisted(() => {
  type Row = Record<string, any>
  const state = {
    db: {} as Record<string, Row[]>,
    config: null as any,
    cashback: null as any,
    cashbackError: false,
    ready: true,
    otpVerified: true,
    gates: { storefrontOtp: false, storefrontDirect: false, dashboardDirect: false },
    orderUpdateError: null as null | { message: string },
    walletUpdateError: null as null | { message: string },
    orderUpdates: 0,
    nextId: 1,
  }
  const OPEN = ["pending", "confirming"]
  const ORDER_TABLES = ["hubtel_bill_orders", "hubtel_data_orders", "airtime_orders"]
  const query = (table: string) => {
    const rows = () => (state.db[table] ??= [])
    const filters: ((r: Row) => boolean)[] = []
    let mode: "select" | "insert" | "update" = "select"
    let patch: Row = {}
    let inserted: Row[] = []
    let error: any = null
    let orderBy: { key: string; ascending: boolean } | null = null
    let limitTo: number | null = null
    const matching = () => {
      const hit = rows().filter((r) => filters.every((f) => f(r)))
      if (orderBy) {
        const { key, ascending } = orderBy
        hit.sort((a, b) => (String(a[key]) < String(b[key]) ? -1 : 1) * (ascending ? 1 : -1))
      }
      return limitTo === null ? hit : hit.slice(0, limitTo)
    }
    const run = () => {
      if (mode === "insert") return { data: error ? null : inserted, error }
      if (mode === "update") {
        if (table === "wallet_payments" && state.walletUpdateError) return { data: null, error: state.walletUpdateError }
        if (ORDER_TABLES.includes(table) && state.orderUpdateError) return { data: null, error: state.orderUpdateError }
        const hit = matching()
        if (ORDER_TABLES.includes(table) && ("paid_amount" in patch || "total_paid" in patch)) state.orderUpdates++
        hit.forEach((r) => Object.assign(r, patch))
        return { data: hit, error: null }
      }
      return { data: matching(), error: null }
    }
    const c: any = {}
    for (const m of ["select", "or", "gt"]) c[m] = () => c
    c.is = (k: string, v: unknown) => (filters.push((r) => (v === null ? r[k] === null || r[k] === undefined : r[k] === v)), c)
    c.eq = (k: string, v: unknown) => (filters.push((r) => r[k] === v), c)
    c.in = (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), c)
    c.gte = (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), c)
    c.order = (key: string, opts?: { ascending?: boolean }) => (orderBy = { key, ascending: opts?.ascending ?? true }, c)
    c.limit = (n: number) => (limitTo = n, c)
    c.insert = (input: Row | Row[]) => {
      mode = "insert"
      inserted = (Array.isArray(input) ? input : [input]).map((r) => ({ id: `row${state.nextId++}`, status: "pending", created_at: new Date().toISOString(), ...r }))
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
    auth: { getUser: async () => ({ data: { user: { id: "user1" } } }), admin: { updateUserById: async () => ({ data: null, error: null }) } },
    rpc: async (_fn: string, args: { p_reference: string }) => {
      const r = (state.db.hubtel_payments ?? []).find((x) => x.reference === args.p_reference && x.status === "pending")
      if (!r) return { data: [], error: null }
      r.status = "confirming"
      r.claimed_at = "claimed"
      return { data: [{ reference: r.reference, claimed_at: r.claimed_at }], error: null }
    },
  }
  return { state, fake, alert: vi.fn(async (_m: string, _u?: boolean) => {}) }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
const chargeMobileMoney = vi.fn(async (p: any) => ({ status: "pay_offline", reference: p.reference }))
const initializePayment = vi.fn(async (p: any) => ({ authorizationUrl: "https://paystack/x", accessCode: "ac", reference: p.reference }))
vi.mock("@/lib/paystack", () => ({
  chargeMobileMoney: (p: any) => chargeMobileMoney(p),
  initializePayment: (p: any) => initializePayment(p),
  verifyPayment: vi.fn(),
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
vi.mock("@/lib/payment-gateway/read-config", () => ({
  getGatewayConfig: async () => h.state.config,
  getSurfaceConfig: async (s: string) => h.state.config.surfaces[s],
}))
vi.mock("@/lib/payment-gateway/hubtel-readiness", () => ({ isHubtelCollectionReady: () => h.state.ready }))
vi.mock("@/lib/cashback/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cashback/config")>()),
  getCashbackConfig: async () => {
    if (h.state.cashbackError) throw new Error("db down")
    return h.state.cashback
  },
}))
vi.mock("@/lib/shop-handle", () => ({ shopHandleOrFilter: () => "x" }))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() })) }))
vi.mock("@/lib/shop-token", () => ({ verifyShopSession: () => ({ valid: true }) }))
vi.mock("@/lib/storefront-otp", () => ({
  isPhoneOtpVerified: async () => h.state.otpVerified,
  isWalletOtpRequired: async () => false,
  isStorefrontOtpRequired: async () => h.state.gates.storefrontOtp,
  isStorefrontDirectChargeEnabled: async () => h.state.gates.storefrontDirect,
  isWalletDirectChargeEnabled: async () => false,
  isDashboardDirectChargeEnabled: async () => h.state.gates.dashboardDirect,
}))
vi.mock("@/lib/security-log", () => ({ logSecurityEvent: vi.fn() }))
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified: async () => ({ allowed: true }) }))
vi.mock("@/lib/custom-domain-lookup", () => ({ resolveTrustedBaseUrl: async () => "https://shop.example" }))
vi.mock("@/lib/refunds/payer-phone", () => ({ recordPayerPhone: vi.fn(async () => {}) }))
// The real confirm runs on these two runtimes; only the dispatch engines and alerts are stubbed.
vi.mock("@/lib/bills/runtime", () => ({ getBillsRuntime: () => ({ db: h.fake, deps: { getOrder: async () => null, alert: h.alert } }) }))
vi.mock("@/lib/standard-bundles/runtime", () => ({ getBundlesRuntime: () => ({ db: h.fake, deps: { getOrder: async () => null, alert: h.alert } }) }))
vi.mock("@/lib/bills/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bills/config")>()),
  getBillsConfig: async () => ({ autoFulfil: false }),
}))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(async () => {}), notifyAdmins: vi.fn(async () => {}), SMSTemplates: new Proxy({}, { get: () => () => "msg" }) }))
vi.mock("@/lib/app-settings", () => ({ getJoinCommunityLink: vi.fn(async () => null) }))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => {}), notifyAdminsPush: vi.fn(async () => {}) }))
vi.mock("@/lib/internal-url", () => ({ getInternalBaseUrl: () => "http://localhost" }))
// The airtime branch's price check is the real handler's; only the post-payment flip and dispatch are faked here.
vi.mock("@/lib/airtime-service", () => ({
  markAirtimeOrderPaid: async (id: string) => {
    const row = (h.state.db.airtime_orders ?? []).find((r) => r.id === id && r.payment_status !== "completed")
    if (row) row.payment_status = "completed"
    return { success: true }
  },
}))
vi.mock("@/lib/results-checker-service", () => ({
  notifyAdminsNewResultsCheckRequest: vi.fn(async () => {}),
  fulfillPaidResultsCheckRequest: vi.fn(async () => ({})),
}))

import { POST } from "./route"
import { confirmHubtelPayment, type HubtelPaymentStore } from "@/lib/hubtel-pay/confirm"
import { handleChargeSuccess } from "@/lib/payments/charge-events"

const ORDER_ID = "11111111-2222-3333-4444-555555555555"
const BASE = 99.87
const FEE = 1.95
const WITH_FEE = 101.82

function config(hubtel: Record<string, { feeBearer?: string }> = {}, paystackMerchant = false) {
  const surfaces: Record<string, any> = {}
  for (const s of ["wallet_topup", "storefront", "dashboard_direct", "sms", "ussd", "whatsapp"]) {
    surfaces[s] = { gateway: "paystack", mode: "checkout", feeBearer: "customer" }
  }
  if (paystackMerchant) surfaces.storefront.feeBearer = "merchant"
  // checkout: hosted Hubtel runs only on a checkout row. Direct charges here are decided by the direct gate, not this field.
  for (const [s, o] of Object.entries(hubtel)) surfaces[s] = { gateway: "hubtel", mode: "checkout", feeBearer: o.feeBearer ?? "customer" }
  return { version: 1, surfaces, hubtelFeePercent: 2 }
}
const HUBTEL = () => config({ storefront: {} })

const send = (body: Record<string, unknown> = {}) =>
  POST(new NextRequest("http://x/api/payments/initialize", {
    method: "POST", headers: { "content-type": "application/json", host: "shop.example" },
    body: JSON.stringify({ orderId: ORDER_ID, orderType: "cs_bill", shopSlug: "myshop", ...body }),
  }))
const momo = (paymentPhone: unknown) => ({ momoDirect: true, paymentPhone })

const order = () => h.state.db.hubtel_bill_orders[0]
const walletRows = () => h.state.db.wallet_payments ?? []
const hubtelRows = () => h.state.db.hubtel_payments ?? []
const REFUSED = { kind: "refused", code: "4000", message: "no" }

/** An order as initializeStorefrontBill writes it: priced for Hubtel (fee NULL) or for Paystack (fee inside). */
const seedOrder = (priced: "hubtel" | "paystack") => {
  h.state.db.hubtel_bill_orders = [{
    id: ORDER_ID, reference_code: "BILL-ABC", channel: "storefront", shop_id: "shop1", status: "pending", payment_status: "unpaid",
    amount: 100, paid_amount: priced === "hubtel" ? BASE : WITH_FEE, payment_fee_amount: priced === "hubtel" ? null : FEE,
    buyer_email: "buyer@example.com", buyer_phone: "0241234567", shop_share_amount: 0, payment_reference: null,
    hubtel_client_reference: null, notes: null, biller: "dstv", verified_at: new Date().toISOString(), created_at: new Date().toISOString(),
  }]
}

function confirmDeps(paidPesewas: number) {
  const store: HubtelPaymentStore = {
    load: async (r) => (hubtelRows().find((x) => x.reference === r) as any) ?? null,
    claim: async (r) => {
      const row = hubtelRows().find((x) => x.reference === r && x.status === "pending")
      if (!row) return null
      row.status = "confirming"
      row.claimed_at = "claimed"
      return row as any
    },
    hasLiveSibling: async () => false,
    hasPaidSibling: async () => false,
    update: async (r, patch) => {
      const row = hubtelRows().find((x) => x.reference === r)
      if (row) Object.assign(row, patch)
      return !!row
    },
  }
  return {
    store,
    checkStatus: async () => ({ kind: "paid", amountPesewas: paidPesewas, paymentMethod: "mobilemoney", transactionId: "abc", raw: {} }) as any,
    notify: async () => {},
  }
}

beforeEach(() => {
  h.state.db = {
    user_shops: [{ id: "shop1", is_active: true, shop_slug: "myshop" }],
    app_settings: [{ paystack_fee_percentage: 3, wallet_topups_enabled: true, upgrades_enabled: true }],
    users: [{ id: "user1", role: "user", phone_number: null, phone_verified: false }],
    results_check_requests: [{ id: ORDER_ID, fee: 10, status: "pending", payment_status: "pending_payment", phone_number: "0241234567" }],
  }
  seedOrder("hubtel")
  h.state.config = HUBTEL()
  h.state.cashback = { enabled: true, surfaces: { storefront: true }, storefrontGroups: { bills: true, bundles: true }, paymentFee: { bills: 1.95, bundles: 1.95 } }
  h.state.cashbackError = false
  h.state.ready = true
  h.state.otpVerified = true
  h.state.gates = { storefrontOtp: false, storefrontDirect: false, dashboardDirect: false }
  h.state.orderUpdateError = null
  h.state.walletUpdateError = null
  h.state.orderUpdates = 0
  h.alert.mockClear()
  chargeMobileMoney.mockClear()
  initializePayment.mockClear()
  receiveMoney.mockReset()
  receiveMoney.mockImplementation(async () => ({ kind: "accepted" }))
  initiateCheckout.mockReset()
  initiateCheckout.mockImplementation(async () => ({ kind: "accepted", checkoutUrl: "https://pay.hubtel.com/abc" }))
})

describe("every surface on Paystack: unchanged, through the real wrappers", () => {
  beforeEach(() => {
    h.state.config = config()
    seedOrder("paystack")
    h.state.cashbackError = true // Never read on this path.
  })

  it("hosted: paid_amount charged as it stands, no write to the order", async () => {
    const res = await send()
    expect(res.status).toBe(200)
    const row = walletRows()[0]
    expect(row).toMatchObject({ amount: WITH_FEE, fee: 0, payment_method: "paystack", status: "pending", order_type: "cs_bill", order_id: ORDER_ID })
    const p = initializePayment.mock.calls[0][0] as any
    expect(p).toMatchObject({ amount: WITH_FEE, reference: row.reference, channel: "shop_order", purpose: "Shop order", email: "buyer@example.com", channels: ["card", "mobile_money", "bank_transfer"] })
    expect(p.metadata).toMatchObject({ paystackFee: 0, originalAmount: WITH_FEE, orderType: "shop_order" })
    expect(await res.json()).toEqual({ success: true, authorizationUrl: "https://paystack/x", accessCode: "ac", reference: row.reference, paymentId: row.id })
    expect(h.state.orderUpdates).toBe(0)
    expect(order()).toMatchObject({ paid_amount: WITH_FEE, payment_fee_amount: FEE })
    expect(hubtelRows()).toHaveLength(0)
  })

  it("direct: the raw number, same amount, no write to the order", async () => {
    h.state.gates.storefrontDirect = true
    const res = await send(momo("024 123 4567"))
    expect(res.status).toBe(200)
    const row = walletRows()[0]
    expect(chargeMobileMoney.mock.calls[0][0]).toMatchObject({ amount: WITH_FEE, phone: "024 123 4567", provider: "mtn", reference: row.reference })
    expect(await res.json()).toEqual({ success: true, momoDirect: true, reference: row.reference, status: "pay_offline", paymentId: row.id })
    expect(h.state.orderUpdates).toBe(0)
    expect(receiveMoney).not.toHaveBeenCalled()
  })

  it("a fee of 0 stays 0: only NULL means priced for Hubtel", async () => {
    order().paid_amount = BASE
    order().payment_fee_amount = 0
    expect((await send()).status).toBe(200)
    expect((initializePayment.mock.calls[0][0] as any).amount).toBe(BASE)
    expect(h.state.orderUpdates).toBe(0)
  })

  it("the real webhook confirms the payment against paid_amount", async () => {
    await send()
    const res = await handleChargeSuccess({ reference: walletRows()[0].reference, amount: 10182, id: 123 })
    expect(await res!.json()).toEqual({ received: true })
    expect(order().payment_status).toBe("paid")
  })
})

describe("the surface is on Paystack and the order was priced for Hubtel", () => {
  it("the customer pays the full fee, and paid_amount says so", async () => {
    h.state.config = config()
    const res = await send()
    expect(res.status).toBe(200)
    expect((initializePayment.mock.calls[0][0] as any).amount).toBe(WITH_FEE)
    expect(order()).toMatchObject({ paid_amount: WITH_FEE, payment_fee_amount: FEE })
    expect(walletRows()[0]).toMatchObject({ amount: WITH_FEE, fee: 0, payment_method: "paystack" })
  })
})

describe("priced for Hubtel, on Hubtel", () => {
  it("hosted: no fee in the amount; the real confirm passes to the pesewa with Hubtel's charge on top", async () => {
    const res = await send()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ authorizationUrl: "https://pay.hubtel.com/abc" })
    expect(initiateCheckout.mock.calls[0][0]).toMatchObject({ amount: BASE, description: "Payment" })
    expect(walletRows()[0]).toMatchObject({ amount: BASE, fee: 0, payment_method: "hubtel" })
    expect(h.state.orderUpdates).toBe(0)
    expect(await confirmHubtelPayment(hubtelRows()[0].reference, confirmDeps(10186))).toBe("fulfilled")
    expect(order()).toMatchObject({ payment_status: "paid", payment_reference: walletRows()[0].reference })
    expect(walletRows()[0].status).toBe("completed")
  })

  it.each(["0241234567", "024 123 4567", "241234567", "+233 24 123 4567", "0241234567x"])("direct, %s: the canonical number at the fee-free price", async (phone) => {
    h.state.gates.storefrontDirect = true
    const res = await send(momo(phone))
    expect(res.status).toBe(200)
    expect(receiveMoney.mock.calls[0][0]).toMatchObject({ msisdn: "233241234567", amount: BASE })
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(order()).toMatchObject({ paid_amount: BASE, payment_fee_amount: null })
  })

  it("the merchant bears the fee: the real confirm is told the full paid_amount", async () => {
    h.state.config = config({ storefront: { feeBearer: "merchant" } })
    await send()
    expect(hubtelRows()[0]).toMatchObject({ amount_pesewas: 9787, handler_amount_pesewas: 9987 })
    expect(await confirmHubtelPayment(hubtelRows()[0].reference, confirmDeps(9787))).toBe("fulfilled")
    expect(order().payment_status).toBe("paid")
  })
})

describe("priced with the fee inside, and the surface is now on Hubtel", () => {
  it("the fee comes out before Hubtel is asked, so the customer doesn't pay Paystack's fee and Hubtel's", async () => {
    seedOrder("paystack")
    const res = await send()
    expect(res.status).toBe(200)
    expect(initiateCheckout.mock.calls[0][0]).toMatchObject({ amount: BASE })
    expect(order()).toMatchObject({ paid_amount: BASE, payment_fee_amount: null })
    expect(walletRows()[0]).toMatchObject({ amount: BASE, payment_method: "hubtel" })
    expect(await confirmHubtelPayment(hubtelRows()[0].reference, confirmDeps(9987))).toBe("fulfilled")
    expect(order().payment_status).toBe("paid")
  })

  it("the write fails => 503, nothing written or sent, price untouched", async () => {
    seedOrder("paystack")
    h.state.orderUpdateError = { message: "db down" }
    const res = await send()
    expect(res.status).toBe(503)
    expect(walletRows()).toHaveLength(0)
    expect(initiateCheckout).not.toHaveBeenCalled()
    expect(order().paid_amount).toBe(WITH_FEE)
  })
})

describe("priced for Hubtel, but this payment can't be on Hubtel: the full fee from the start", () => {
  it("hosted while direct charge is on: MoMo must stay stripped, which only Paystack can do", async () => {
    h.state.gates.storefrontDirect = true
    const res = await send()
    expect(res.status).toBe(200)
    expect(initiateCheckout).not.toHaveBeenCalled()
    expect(initializePayment.mock.calls[0][0]).toMatchObject({ amount: WITH_FEE, channels: ["card", "bank_transfer"] })
    expect(order()).toMatchObject({ paid_amount: WITH_FEE, payment_fee_amount: FEE })
    expect(walletRows()[0]).toMatchObject({ amount: WITH_FEE, payment_method: "paystack" })
  })

  it("a number with no canonical form", async () => {
    h.state.gates.storefrontDirect = true
    const res = await send(momo("024123456"))
    expect(res.status).toBe(200)
    expect(receiveMoney).not.toHaveBeenCalled()
    expect(chargeMobileMoney.mock.calls[0][0]).toMatchObject({ amount: WITH_FEE, phone: "024123456" })
    expect(order()).toMatchObject({ paid_amount: WITH_FEE, payment_fee_amount: FEE })
  })

  it.each<[string, () => void]>([
    ["the fee can't be read", () => { h.state.cashbackError = true }],
    ["the order write fails", () => { h.state.orderUpdateError = { message: "db down" } }],
  ])("%s => 503, nothing charged", async (_n, arrange) => {
    h.state.gates.storefrontDirect = true
    arrange()
    const res = await send()
    expect(res.status).toBe(503)
    expect(initializePayment).not.toHaveBeenCalled()
    expect(walletRows()).toHaveLength(0)
  })

  it("a fee rate of 0 leaves the order alone", async () => {
    h.state.gates.storefrontDirect = true
    h.state.cashback.paymentFee.bills = 0
    expect((await send()).status).toBe(200)
    expect((initializePayment.mock.calls[0][0] as any).amount).toBe(BASE)
    expect(h.state.orderUpdates).toBe(0)
  })

  it("the storefront group switched off: no fee, as a quote would give", async () => {
    h.state.gates.storefrontDirect = true
    h.state.cashback.storefrontGroups.bills = false
    expect((await send()).status).toBe(200)
    expect((initializePayment.mock.calls[0][0] as any).amount).toBe(BASE)
  })
})

describe("a fallback after a Hubtel refusal: paid_amount and the amount charged move together", () => {
  const start = {
    direct: { arrange: () => { h.state.gates.storefrontDirect = true; receiveMoney.mockImplementation(async () => REFUSED) }, body: momo("024 123 4567"), paystack: () => chargeMobileMoney, relay: () => receiveMoney },
    hosted: { arrange: () => { initiateCheckout.mockImplementation(async () => REFUSED) }, body: {}, paystack: () => initializePayment, relay: () => initiateCheckout },
  } as const

  describe.each(["direct", "hosted"] as const)("%s", (kind) => {
    const s = start[kind]
    beforeEach(() => s.arrange())

    it("the full fee is charged, the order and the payment row say so, and the real confirm accepts it", async () => {
      const res = await send(s.body)
      expect(res.status).toBe(200)
      expect(s.paystack()).toHaveBeenCalledTimes(1)
      const sent = s.paystack().mock.calls[0][0] as any
      expect(sent.amount).toBe(WITH_FEE)
      expect(sent.metadata).toMatchObject({ originalAmount: WITH_FEE, paystackFee: 0 })
      expect(order()).toMatchObject({ paid_amount: WITH_FEE, payment_fee_amount: FEE })
      expect(walletRows()).toHaveLength(1)
      expect(walletRows()[0]).toMatchObject({ amount: WITH_FEE, fee: 0, payment_method: "paystack", status: "pending" })
      expect(hubtelRows()[0].status).toBe("failed")

      const paid = await handleChargeSuccess({ reference: sent.reference, amount: 10182, id: 123 })
      expect(await paid!.json()).toEqual({ received: true })
      expect(order().payment_status).toBe("paid")
    })

    it("a fee-less amount can't pass the real confirm once the order is repriced", async () => {
      await send(s.body)
      const sent = s.paystack().mock.calls[0][0] as any
      const res = await handleChargeSuccess({ reference: sent.reference, amount: 9987, id: 123 })
      expect(await res!.json()).toEqual({ received: true, order_closed: true })
      expect(order().payment_status).toBe("unpaid")
    })

    it.each<[string, () => void]>([
      ["the order write errors", () => { h.state.orderUpdateError = { message: "db down" } }],
      ["the order is no longer unpaid", () => { order().payment_status = "paid" }],
      ["the payment row write errors", () => { h.state.walletUpdateError = { message: "db down" } }],
      ["the fee can't be read", () => { h.state.cashbackError = true }],
    ])("%s => 503, nothing charged", async (_n, breakIt) => {
      s.relay().mockImplementation(async () => { breakIt(); return REFUSED })
      const res = await send(s.body)
      expect(res.status).toBe(503)
      expect((await res.json()).error).toMatch(/try again/i)
      expect(s.paystack()).not.toHaveBeenCalled()
      expect(hubtelRows()[0].status).toBe("failed")
    })

    it("after a failed payment-row write the next try puts the price right again", async () => {
      s.relay().mockImplementationOnce(async () => { h.state.walletUpdateError = { message: "db down" }; return REFUSED })
      expect((await send(s.body)).status).toBe(503)
      expect(order()).toMatchObject({ paid_amount: WITH_FEE, payment_fee_amount: FEE })
      h.state.walletUpdateError = null
      walletRows()[0].created_at = new Date(Date.now() - 4 * 60_000).toISOString()
      s.relay().mockImplementation(async () => (kind === "direct" ? { kind: "accepted" } : { kind: "accepted", checkoutUrl: "https://pay.hubtel.com/abc" }))
      expect((await send(s.body)).status).toBe(200)
      expect(order()).toMatchObject({ paid_amount: BASE, payment_fee_amount: null })
      expect(walletRows()[walletRows().length - 1]).toMatchObject({ amount: BASE, payment_method: "hubtel" })
    })

    it("the merchant bears the fee: Paystack is charged paid_amount as it stands", async () => {
      h.state.config = config({ storefront: { feeBearer: "merchant" } })
      const res = await send(s.body)
      expect(res.status).toBe(200)
      expect((s.paystack().mock.calls[0][0] as any).amount).toBe(BASE)
      expect(order()).toMatchObject({ paid_amount: BASE, payment_fee_amount: null })
      expect(h.state.orderUpdates).toBe(0)
    })
  })
})

describe("a bundle order prices from its own table and fee group", () => {
  beforeEach(() => {
    h.state.db.hubtel_data_orders = [{ ...order(), biller: undefined }]
    h.state.db.hubtel_bill_orders = []
    h.state.cashback.paymentFee = { bills: 9, bundles: 1.95 }
  })
  const bundle = () => h.state.db.hubtel_data_orders[0]

  it("fallback: the bundle group's fee, on the bundle row, and the real confirm accepts it", async () => {
    initiateCheckout.mockImplementation(async () => REFUSED)
    const res = await send({ orderType: "cs_bundle" })
    expect(res.status).toBe(200)
    const sent = initializePayment.mock.calls[0][0] as any
    expect(sent.amount).toBe(WITH_FEE)
    expect(bundle()).toMatchObject({ paid_amount: WITH_FEE, payment_fee_amount: FEE })
    await handleChargeSuccess({ reference: sent.reference, amount: 10182, id: 123 })
    expect(bundle().payment_status).toBe("paid")
  })

  it("Hubtel: the real confirm passes on the fee-free amount", async () => {
    await send({ orderType: "cs_bundle" })
    expect(await confirmHubtelPayment(hubtelRows()[0].reference, confirmDeps(9987))).toBe("fulfilled")
    expect(bundle().payment_status).toBe("paid")
  })
})

describe("Paystack with the merchant bearing the fee: no fee for the customer", () => {
  it("an order priced with the fee has it taken out", async () => {
    seedOrder("paystack")
    h.state.config = config({}, true)
    expect((await send()).status).toBe(200)
    expect((initializePayment.mock.calls[0][0] as any).amount).toBe(BASE)
    expect(order()).toMatchObject({ paid_amount: BASE, payment_fee_amount: null })
  })

  it("a fee-free order stays fee-free", async () => {
    h.state.config = config({}, true)
    h.state.cashbackError = true
    expect((await send()).status).toBe(200)
    expect((initializePayment.mock.calls[0][0] as any).amount).toBe(BASE)
    expect(h.state.orderUpdates).toBe(0)
  })
})

describe("a retry during an open attempt", () => {
  // The route's own 3-minute guard answers first; the replay rule takes over after it.
  const past3Minutes = () => { walletRows()[0].created_at = new Date(Date.now() - 4 * 60_000).toISOString() }

  it("inside 3 minutes => today's 409, no second prompt", async () => {
    h.state.gates.storefrontDirect = true
    await send(momo("0241234567"))
    const retry = await send(momo("0241234567"))
    expect(retry.status).toBe(409)
    expect(receiveMoney).toHaveBeenCalledTimes(1)
  })

  it.each(["024 123 4567", "+233 24 123 4567", "241234567"])("direct, retry with %s => the same reference, one prompt", async (phone) => {
    h.state.gates.storefrontDirect = true
    const { reference } = await (await send(momo("0241234567"))).json()
    past3Minutes()
    const retry = await send(momo(phone))
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ reference, status: "pay_offline" })
    expect(receiveMoney).toHaveBeenCalledTimes(1)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(walletRows()).toHaveLength(1)
    expect(h.state.orderUpdates).toBe(0)
  })

  it("hosted => the same link", async () => {
    const { reference } = await (await send()).json()
    past3Minutes()
    expect(await (await send()).json()).toMatchObject({ reference, authorizationUrl: "https://pay.hubtel.com/abc" })
    expect(initiateCheckout).toHaveBeenCalledTimes(1)
  })

  it("the surface flips to Paystack => 409 and the price isn't touched", async () => {
    await send()
    past3Minutes()
    h.state.config = config()
    const retry = await send()
    expect(retry.status).toBe(409)
    expect(initializePayment).not.toHaveBeenCalled()
    expect(order()).toMatchObject({ paid_amount: BASE, payment_fee_amount: null })
    expect(h.state.orderUpdates).toBe(0)
  })
})

describe("the order must still be payable", () => {
  it.each<[string, Record<string, unknown>]>([
    ["paid", { payment_status: "paid" }],
    ["failed", { status: "failed" }],
  ])("%s => no start on any gateway and no price change", async (_n, patch) => {
    Object.assign(order(), patch)
    expect((await send()).status).toBe(400)
    expect(initiateCheckout).not.toHaveBeenCalled()
    expect(initializePayment).not.toHaveBeenCalled()
    expect(h.state.orderUpdates).toBe(0)
  })

  it("another shop's order => no start", async () => {
    order().shop_id = "other"
    expect((await send()).status).toBe(400)
    expect(initiateCheckout).not.toHaveBeenCalled()
  })

  it("a bot order is left alone: no surface yet, no reprice", async () => {
    Object.assign(order(), { channel: "bots", shop_id: null })
    const res = await POST(new NextRequest("http://x/api/payments/initialize", {
      method: "POST", headers: { "content-type": "application/json", host: "shop.example" },
      body: JSON.stringify({ orderId: ORDER_ID, orderType: "cs_bill" }),
    }))
    expect(res.status).toBe(200)
    expect((initializePayment.mock.calls[0][0] as any).amount).toBe(BASE)
    expect(h.state.orderUpdates).toBe(0)
  })
})

describe("storefront cashback airtime: total_paid has the payment fee inside it", () => {
  // Face 50, cashback 0 here, fee 1.95% rounded up: 0.98. total_paid 50.98.
  const seedAirtime = (o: Record<string, unknown> = {}) => {
    h.state.db.airtime_orders = [{
      id: ORDER_ID, shop_id: "shop1", status: "pending_payment", payment_status: "pending_payment", beneficiary_phone: "0241234567",
      total_paid: 50.98, payment_fee_amount: 0.98, fee_amount: 0, cashback_rate: 3, ...o,
    }]
  }
  const airtime = () => h.state.db.airtime_orders[0]
  const buy = (body: Record<string, unknown> = {}) =>
    POST(new NextRequest("http://x/api/payments/initialize", {
      method: "POST", headers: { "content-type": "application/json", host: "shop.example" },
      body: JSON.stringify({ orderId: ORDER_ID, orderType: "airtime", shopSlug: "myshop", email: "b@example.com", amount: 1, ...body }),
    }))
  // null is the handler's plain "done" (the webhook route answers 200 for it).
  const settle = async (reference: string, pesewas: number) => (await handleChargeSuccess({ reference, amount: pesewas, id: 123 }))?.status ?? 200
  beforeEach(() => {
    seedAirtime()
    h.state.cashback = { ...h.state.cashback, storefrontGroups: { ...h.state.cashback.storefrontGroups, airtime: true }, paymentFee: { ...h.state.cashback.paymentFee, airtime: 1.95 } }
  })

  it("Paystack: total_paid charged as it stands, no write to the order", async () => {
    h.state.config = config()
    h.state.cashbackError = true
    expect((await buy()).status).toBe(200)
    expect((initializePayment.mock.calls[0][0] as any).amount).toBe(50.98)
    expect(h.state.orderUpdates).toBe(0)
    expect(await settle(walletRows()[0].reference, 5098)).toBe(200)
    expect(airtime().payment_status).toBe("completed")
  })

  it("Hubtel: the fee comes out of total_paid before Hubtel is asked, and the real handler settles it", async () => {
    expect((await buy()).status).toBe(200)
    expect(initiateCheckout.mock.calls[0][0]).toMatchObject({ amount: 50 })
    expect(airtime()).toMatchObject({ total_paid: 50, payment_fee_amount: null })
    expect(walletRows()[0]).toMatchObject({ amount: 50, fee: 0, payment_method: "hubtel" })
    expect(await confirmHubtelPayment(hubtelRows()[0].reference, confirmDeps(5100))).toBe("fulfilled")
    expect(airtime().payment_status).toBe("completed")
  })

  it("fallback after a refusal: price + fee is charged, total_paid says so, the handler settles it", async () => {
    initiateCheckout.mockImplementation(async () => REFUSED)
    expect((await buy()).status).toBe(200)
    const sent = initializePayment.mock.calls[0][0] as any
    expect(sent.amount).toBe(50.98)
    expect(airtime()).toMatchObject({ total_paid: 50.98, payment_fee_amount: 0.98 })
    expect(walletRows()[0]).toMatchObject({ amount: 50.98, payment_method: "paystack" })
    expect(await settle(sent.reference, 5000)).toBe(400)
    expect(airtime().payment_status).toBe("pending_payment")
    expect(await settle(sent.reference, 5098)).toBe(200)
    expect(airtime().payment_status).toBe("completed")
  })

  it.each<[string, () => void]>([
    ["the order write errors", () => { h.state.orderUpdateError = { message: "db down" } }],
    ["the order was paid meanwhile", () => { airtime().status = "processing" }],
    ["the fee can't be read", () => { h.state.cashbackError = true }],
  ])("fallback: %s => 503, nothing charged", async (_n, breakIt) => {
    initiateCheckout.mockImplementation(async () => { breakIt(); return REFUSED })
    expect((await buy()).status).toBe(503)
    expect(initializePayment).not.toHaveBeenCalled()
  })

  it("the order write fails before Hubtel => 503, nothing written or sent", async () => {
    h.state.orderUpdateError = { message: "db down" }
    expect((await buy()).status).toBe(503)
    expect(initiateCheckout).not.toHaveBeenCalled()
    expect(walletRows()).toHaveLength(0)
    expect(airtime().total_paid).toBe(50.98)
  })

  it.each<[string, Record<string, unknown>]>([
    ["a USSD bot order", { channel: "ussd", shop_id: null }],
    ["a USSD shop bot order of this shop", { channel: "ussd_shop" }],
    ["a WhatsApp shop bot order of this shop", { channel: "whatsapp_shop" }],
    ["another shop's storefront order", { shop_id: "other-shop" }],
  ])("%s => refused on this route, on any gateway, and never repriced", async (_n, over) => {
    for (const cfg of [HUBTEL(), config()]) {
      seedAirtime(over)
      h.state.config = cfg
      const res = await buy()
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "Invalid order ID" })
    }
    expect(initiateCheckout).not.toHaveBeenCalled()
    expect(initializePayment).not.toHaveBeenCalled()
    expect(h.state.orderUpdates).toBe(0)
    expect(walletRows()).toHaveLength(0)
  })

  it("no shop slug => refused (every storefront page sends one)", async () => {
    const res = await buy({ shopSlug: undefined })
    expect(res.status).toBe(400)
    expect(initiateCheckout).not.toHaveBeenCalled()
    expect(h.state.orderUpdates).toBe(0)
  })

  it("the reprice write itself only matches this shop's storefront row", async () => {
    const { airtimeRepriceSpec, priceOrderForGateway } = await import("@/lib/storefront-commission/reprice")
    const price = { paid: 50.98, fee: 0.98 }
    seedAirtime({ channel: "ussd_shop" })
    expect(await priceOrderForGateway(h.fake as any, airtimeRepriceSpec("shop1"), ORDER_ID, price, true)).toEqual({ ok: false })
    seedAirtime()
    expect(await priceOrderForGateway(h.fake as any, airtimeRepriceSpec("other-shop"), ORDER_ID, price, true)).toEqual({ ok: false })
    expect(airtime().total_paid).toBe(50.98)
    expect(await priceOrderForGateway(h.fake as any, airtimeRepriceSpec("shop1"), ORDER_ID, price, true)).toEqual({ ok: true, price: { paid: 50, fee: null } })
  })

  it.each<[string, () => void]>([
    ["on Hubtel", () => {}],
    ["on fallback", () => { initiateCheckout.mockImplementation(async () => REFUSED) }],
  ])("a legacy airtime order (fee_amount is margin, no cashback snapshot) is untouched %s", async (_n, arrange) => {
    seedAirtime({ cashback_rate: null, payment_fee_amount: null, fee_amount: 2, total_paid: 52 })
    arrange()
    expect((await buy()).status).toBe(200)
    expect(airtime()).toMatchObject({ total_paid: 52, fee_amount: 2, payment_fee_amount: null })
    expect(h.state.orderUpdates).toBe(0)
  })
})

describe("the results-check service: its only start is this route, on dashboard_direct", () => {
  const rc = (body: Record<string, unknown> = {}) =>
    POST(new NextRequest("http://x/api/payments/initialize", {
      method: "POST", headers: { "content-type": "application/json", host: "shop.example", Authorization: "Bearer tok" },
      body: JSON.stringify({ orderId: ORDER_ID, orderType: "results_check_service", email: "dealer@example.com", amount: 1, ...body }),
    }))

  it("Paystack: the fee and the labels as today", async () => {
    h.state.config = config()
    expect((await rc()).status).toBe(200)
    expect((initializePayment.mock.calls[0][0] as any)).toMatchObject({ amount: 10.3, channel: "shop_results_check", purpose: "Results Check Service" })
    expect(walletRows()[0]).toMatchObject({ amount: 10.3, fee: 0.3, payment_method: "paystack" })
  })

  it("Hubtel: no fee, on the dashboard_direct surface", async () => {
    h.state.config = config({ dashboard_direct: {} })
    expect((await rc()).status).toBe(200)
    expect(initiateCheckout.mock.calls[0][0]).toMatchObject({ amount: 10 })
    expect(hubtelRows()[0]).toMatchObject({ surface: "dashboard_direct" })
    expect(walletRows()[0]).toMatchObject({ amount: 10, fee: 0, payment_method: "hubtel" })
  })

  it("fallback: the full fee on the row and the charge", async () => {
    h.state.config = config({ dashboard_direct: {} })
    initiateCheckout.mockImplementation(async () => REFUSED)
    expect((await rc()).status).toBe(200)
    expect((initializePayment.mock.calls[0][0] as any).amount).toBe(10.3)
    expect(walletRows()[0]).toMatchObject({ amount: 10.3, fee: 0.3, payment_method: "paystack" })
  })
})
