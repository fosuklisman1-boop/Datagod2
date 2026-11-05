import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Storefront AFA with the REAL wrappers, and the REAL handleChargeSuccess for the confirm pin. The order id is the
// reference (no wallet_payments row). Only the network edges and the fulfilment engine are fakes.

const h = vi.hoisted(() => {
  type Row = Record<string, any>
  const state = {
    db: {} as Record<string, Row[]>,
    config: null as any,
    ready: true,
    capped: [] as string[],
    nextId: 1,
    hubtelReadError: null as null | { message: string },
    orderReadError: null as null | { message: string },
    reads: [] as string[],
  }
  const OPEN = ["pending", "confirming"]
  const query = (table: string) => {
    const rows = () => (state.db[table] ??= [])
    const filters: ((r: Row) => boolean)[] = []
    let mode: "select" | "insert" | "update" = "select"
    let patch: Row = {}
    let inserted: Row[] = []
    let error: any = null
    let limitTo: number | null = null
    const matching = () => {
      const hit = rows().filter((r) => filters.every((f) => f(r)))
      return limitTo === null ? hit : hit.slice(0, limitTo)
    }
    const run = () => {
      if (mode === "insert") return { data: error ? null : inserted, error }
      if (mode === "update") {
        const hit = matching()
        hit.forEach((r) => Object.assign(r, patch))
        return { data: hit, error: null }
      }
      state.reads.push(table)
      if (table === "hubtel_payments" && state.hubtelReadError) return { data: null, error: state.hubtelReadError }
      if (table === "ussd_afa_orders" && state.orderReadError) return { data: null, error: state.orderReadError }
      return { data: matching(), error: null }
    }
    const c: any = {}
    for (const m of ["select", "or", "is", "gt", "order", "lte"]) c[m] = () => c
    c.eq = (k: string, v: unknown) => (filters.push((r) => r[k] === v), c)
    c.in = (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), c)
    c.gte = (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), c)
    c.limit = (n: number) => (limitTo = n, c)
    c.insert = (input: Row | Row[]) => {
      mode = "insert"
      inserted = (Array.isArray(input) ? input : [input]).map((r) => ({
        id: `order-${state.nextId++}`, status: "pending", created_at: new Date().toISOString(), ...r,
      }))
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
    rpc: async (_fn: string, args: { p_reference: string }) => {
      const r = (state.db.hubtel_payments ?? []).find((x) => x.reference === args.p_reference && x.status === "pending")
      if (!r) return { data: [], error: null }
      r.status = "confirming"
      r.claimed_at = "claimed"
      return { data: [{ reference: r.reference, claimed_at: r.claimed_at }], error: null }
    },
  }
  return { state, fake, fulfill: vi.fn(async (_id: string) => ({ success: true, message: "ok" })) }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
const initializePayment = vi.fn(async (p: any) => ({ authorizationUrl: "https://paystack/x", accessCode: "ac", reference: p.reference }))
vi.mock("@/lib/paystack", () => ({
  chargeMobileMoney: vi.fn(),
  initializePayment: (p: any) => initializePayment(p),
}))
const initiateCheckout = vi.fn(async (_p: any): Promise<any> => ({ kind: "accepted", checkoutUrl: "https://pay.hubtel.com/abc" }))
vi.mock("@/lib/hubtel-pay/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hubtel-pay/client")>()),
  receiveMoney: vi.fn(),
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
vi.mock("@/lib/shop-handle", () => ({ shopHandleOrFilter: () => "x" }))
vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: vi.fn(async (_r: unknown, name: string) => ({ allowed: !h.state.capped.includes(name), resetAt: Date.now() })),
}))
vi.mock("@/lib/turnstile", () => ({ verifyTurnstileToken: async () => ({ valid: true }), getRequestIp: () => "1.1.1.1", isTurnstileEnabled: async () => false }))
vi.mock("@/lib/storefront-otp", () => ({ isStorefrontOtpRequired: async () => false, isPhoneOtpVerified: async () => true }))
vi.mock("@/lib/custom-domain-lookup", () => ({ resolveTrustedBaseUrl: async () => "https://shop.example.com" }))
vi.mock("@/lib/ussd/fulfill-afa", () => ({ fulfillUssdAfaOrder: (id: string) => h.fulfill(id) }))
vi.mock("@/lib/customer-tracking-service", () => ({ customerTrackingService: { trackCustomer: vi.fn(async () => ({})) } }))
vi.mock("@/lib/security-log", () => ({ logSecurityEvent: vi.fn() }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(async () => {}), notifyAdmins: vi.fn(async () => {}), SMSTemplates: new Proxy({}, { get: () => () => "msg" }) }))
vi.mock("@/lib/app-settings", () => ({ getJoinCommunityLink: vi.fn(async () => null) }))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => {}), notifyAdminsPush: vi.fn(async () => {}) }))
vi.mock("@/lib/internal-url", () => ({ getInternalBaseUrl: () => "http://localhost" }))
vi.mock("@/lib/results-checker-service", () => ({ notifyAdminsNewResultsCheckRequest: vi.fn(async () => {}) }))

import { POST, maxDuration } from "./route"
import { confirmHubtelPayment, type HubtelPaymentStore } from "@/lib/hubtel-pay/confirm"

function config(storefront?: { feeBearer?: string }) {
  const surfaces: Record<string, any> = {}
  for (const s of ["wallet_topup", "storefront", "dashboard_direct", "sms", "ussd", "whatsapp"]) {
    surfaces[s] = { gateway: "paystack", mode: "checkout", feeBearer: "customer" }
  }
  if (storefront) surfaces.storefront = { gateway: "hubtel", mode: "checkout", feeBearer: storefront.feeBearer ?? "customer" }
  return { version: 1, surfaces, hubtelFeePercent: 2 }
}

const FORM = {
  shopSlug: "myshop", fullName: "Ama", ghCardNumber: "GHA-123456789-0", location: "Accra", region: "Greater Accra",
  phoneNumber: "024 123 4567", customerEmail: "buyer@example.com",
}
const send = (over: Record<string, unknown> = {}) =>
  POST(new NextRequest("http://x/api/shop/afa/initialize", {
    method: "POST", headers: { "content-type": "application/json", host: "shop.example.com" }, body: JSON.stringify({ ...FORM, ...over }),
  }))
const orders = () => h.state.db.ussd_afa_orders ?? []
const hubtelRows = () => h.state.db.hubtel_payments ?? []
const REFUSED = { kind: "refused", code: "4000", message: "no" }

beforeEach(() => {
  h.state.db = {
    user_shops: [{ id: "shop1", afa_price: 30, is_active: true }],
    afa_registration_prices: [{ name: "default", is_active: true, price: "20" }],
    admin_settings: [],
  }
  h.state.config = config()
  h.state.ready = true
  h.state.capped = []
  h.state.hubtelReadError = null
  h.state.orderReadError = null
  h.state.reads = []
  h.fulfill.mockClear()
  initializePayment.mockClear()
  initiateCheckout.mockReset()
  initiateCheckout.mockImplementation(async () => ({ kind: "accepted", checkoutUrl: "https://pay.hubtel.com/abc" }))
})

describe("storefront on Paystack: unchanged", () => {
  it("same params, same answer, no Hubtel row, at most one extra read", async () => {
    const res = await send()
    expect(res.status).toBe(200)
    const orderId = orders()[0].id
    expect(await res.json()).toEqual({ success: true, orderId, authorizationUrl: "https://paystack/x" })
    expect(initializePayment.mock.calls[0][0]).toEqual({
      email: "buyer@example.com", amount: 30, reference: orderId,
      redirectUrl: `https://shop.example.com/shop/myshop/afa/confirmation?orderId=${orderId}`,
      metadata: { shopId: "shop1", shopSlug: "myshop", orderType: "shop_afa" },
    })
    expect(orders()[0]).toMatchObject({ amount: 30, merchant_commission: 10, dialing_phone: "0241234567", payment_status: "pending" })
    expect(hubtelRows()).toHaveLength(0)
    expect(initiateCheckout).not.toHaveBeenCalled()
    expect(h.state.reads.filter((t) => t === "hubtel_payments")).toHaveLength(0)
    expect(h.state.reads.filter((t) => t === "ussd_afa_orders")).toHaveLength(1)
  })

  it("a repeat submit with no live Hubtel attempt: a new order, as today", async () => {
    await send()
    await send()
    expect(orders()).toHaveLength(2)
    expect(initializePayment).toHaveBeenCalledTimes(2)
  })

  it.each<[string, () => void]>([
    ["the order read", () => { h.state.orderReadError = { message: "db down" } }],
  ])("%s failing on a Paystack surface proceeds as today", async (_n, arrange) => {
    arrange()
    expect((await send()).status).toBe(200)
    expect(initializePayment).toHaveBeenCalledTimes(1)
  })

  it("a failed Paystack start keeps today's 500", async () => {
    initializePayment.mockImplementationOnce(async () => { throw new Error("paystack down") })
    const res = await send()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Failed to start payment. Please try again." })
  })
})

describe("storefront on Hubtel", () => {
  beforeEach(() => { h.state.config = config({}) })

  it("a Hubtel link at the shop price; the order id is the internal reference; the confirmation page is the return", async () => {
    const res = await send()
    expect(res.status).toBe(200)
    const orderId = orders()[0].id
    expect(await res.json()).toEqual({ success: true, orderId, authorizationUrl: "https://pay.hubtel.com/abc" })
    expect(initiateCheckout.mock.calls[0][0]).toMatchObject({ amount: 30, description: "Payment" })
    expect(initiateCheckout.mock.calls[0][0].reference).not.toBe(orderId)
    expect(hubtelRows()[0]).toMatchObject({ internal_reference: orderId, surface: "storefront", mode: "checkout", amount_pesewas: 3000 })
    expect(hubtelRows()[0].metadata).toMatchObject({
      shopId: "shop1", orderType: "shop_afa", gateway: "hubtel",
      redirect_url: `https://shop.example.com/shop/myshop/afa/confirmation?orderId=${orderId}`,
    })
    expect(initializePayment).not.toHaveBeenCalled()
  })

  it.each(["024 123 4567", "241234567", "+233 24 123 4567", "0241234567x"])("a retry with the number typed %s: same order, same link, no second row", async (phoneNumber) => {
    await send({ phoneNumber: "0241234567" })
    const retry = await send({ phoneNumber })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ success: true, orderId: orders()[0].id, authorizationUrl: "https://pay.hubtel.com/abc" })
    expect(orders()).toHaveLength(1)
    expect(hubtelRows()).toHaveLength(1)
    expect(initiateCheckout).toHaveBeenCalledTimes(1)
  })

  it.each<[string, Record<string, unknown>]>([
    ["name", { fullName: "Ama Mensah" }],
    ["phone", { phoneNumber: "0201234567" }],
    ["location", { location: "Kumasi" }],
    ["region", { region: "Ashanti" }],
  ])("a retry with a corrected %s during an open attempt => 409, the paid order's details never change silently", async (_n, over) => {
    await send()
    const retry = await send(over)
    expect(retry.status).toBe(409)
    expect(await retry.json()).toMatchObject({ code: "PAYMENT_IN_PROGRESS" })
    expect(orders()).toHaveLength(1)
    expect(initiateCheckout).toHaveBeenCalledTimes(1)
    expect(initializePayment).not.toHaveBeenCalled()
  })

  it("the same details with surrounding spaces still replay", async () => {
    await send()
    expect((await send({ fullName: " Ama ", location: "Accra " })).status).toBe(200)
    expect(orders()).toHaveLength(1)
  })

  it("a retry for a different person is a different order", async () => {
    await send()
    await send({ ghCardNumber: "GHA-987654321-0" })
    expect(orders()).toHaveLength(2)
    expect(initiateCheckout).toHaveBeenCalledTimes(2)
  })

  it("a paid or closed earlier order isn't reused", async () => {
    await send()
    orders()[0].payment_status = "completed"
    hubtelRows()[0].status = "paid"
    await send()
    expect(orders()).toHaveLength(2)
    expect(initiateCheckout).toHaveBeenCalledTimes(2)
  })

  it("the surface flips to Paystack during an open attempt => 409, no Paystack link beside it", async () => {
    await send()
    h.state.config = config()
    const retry = await send()
    expect(retry.status).toBe(409)
    expect(await retry.json()).toMatchObject({ code: "PAYMENT_IN_PROGRESS" })
    expect(initializePayment).not.toHaveBeenCalled()
    expect(orders()).toHaveLength(1)
  })

  it.each<[string, () => void]>([
    ["the order read", () => { h.state.orderReadError = { message: "db down" } }],
    ["the attempt read", () => { h.state.hubtelReadError = { message: "db down" } }],
  ])("%s fails on a Hubtel surface => 503, no order and nothing started", async (_n, arrange) => {
    await send()
    expect(initiateCheckout).toHaveBeenCalledTimes(1)
    arrange()
    const res = await send()
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/try again/i)
    expect(orders()).toHaveLength(1)
    expect(initiateCheckout).toHaveBeenCalledTimes(1)
    expect(initializePayment).not.toHaveBeenCalled()
  })

  it("fallback after a refusal: Paystack under the order id at the shop price, which is all Paystack ever charged here", async () => {
    initiateCheckout.mockImplementation(async () => REFUSED)
    const res = await send()
    expect(res.status).toBe(200)
    const orderId = orders()[0].id
    expect(await res.json()).toEqual({ success: true, orderId, authorizationUrl: "https://paystack/x" })
    expect(initializePayment.mock.calls[0][0]).toMatchObject({ amount: 30, reference: orderId })
    expect(hubtelRows()[0].status).toBe("failed")
    expect(orders()[0].amount).toBe(30)
  })

  it("Hubtel's answer is unknown => 503 try again, no fallback; the order waits", async () => {
    initiateCheckout.mockImplementation(async () => ({ kind: "unknown", code: "timeout" }))
    const res = await send()
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/try again/i)
    expect(initializePayment).not.toHaveBeenCalled()
    expect(hubtelRows()[0].status).toBe("pending")
  })

  it("a paid sibling under a reused order => 409 already processing", async () => {
    await send()
    h.state.db.hubtel_payments.push({ ...hubtelRows()[0], reference: "e".repeat(32), status: "paid" })
    const res = await send()
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "already_processing" })
    expect(initiateCheckout).toHaveBeenCalledTimes(1)
  })
})

describe("the real handler credits the order through confirmHubtelPayment", () => {
  const confirmDeps = (paidPesewas: number) => {
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

  it("the AFA branch runs: completed, fulfilled, profit credited", async () => {
    h.state.config = config({})
    await send()
    const row = hubtelRows()[0]
    expect(await confirmHubtelPayment(row.reference, confirmDeps(3060))).toBe("fulfilled")
    expect(orders()[0].payment_status).toBe("completed")
    expect(h.fulfill).toHaveBeenCalledWith(orders()[0].id)
    expect(row.status).toBe("paid")
  })

  it("the merchant bears the fee: less is requested, the handler is told the full price and fulfils", async () => {
    h.state.config = config({ feeBearer: "merchant" })
    await send()
    const row = hubtelRows()[0]
    expect(row).toMatchObject({ amount_pesewas: 2940, handler_amount_pesewas: 3000 })
    expect(await confirmHubtelPayment(row.reference, confirmDeps(2940))).toBe("fulfilled")
    expect(orders()[0].payment_status).toBe("completed")
  })
})

it("declares its time budget", () => {
  expect(maxDuration).toBe(60)
})
