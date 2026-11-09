import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The SMS payment starts with the REAL wrappers (lib/payment-gateway/start.ts) and, for the confirm pins, the REAL
// handleChargeSuccess over an in-memory database. Only the network edges are fakes: Paystack, Hubtel's relay calls,
// the config read, the wholesale balance.

const h = vi.hoisted(() => {
  type Row = Record<string, any>
  const state = {
    db: {} as Record<string, Row[]>,
    rpcCalls: [] as { fn: string; args: any }[],
    config: null as any,
    ready: true,
    otpVerified: true,
    otpGate: false,
    directGate: false,
    smsEnabled: true,
    capped: [] as string[],
    nextId: 1,
    hubtelReadError: null as null | { message: string },
    hubtelInsertError: null as null | { code: string; message: string },
    failRpc: null as null | string,
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
      if (table === "hubtel_payments" && state.hubtelReadError) return { data: null, error: state.hubtelReadError }
      return { data: matching(), error: null }
    }
    const c: any = {}
    for (const m of ["select", "or", "is", "gt", "order", "lte"]) c[m] = () => c
    c.eq = (k: string, v: unknown) => (filters.push((r) => r[k] === v), c)
    c.in = (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), c)
    c.gte = (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), c)
    c.like = (k: string, pattern: string) => (filters.push((r) => String(r[k]).startsWith(pattern.replace(/%$/, ""))), c)
    c.limit = (n: number) => (limitTo = n, c)
    c.insert = (input: Row | Row[]) => {
      mode = "insert"
      inserted = (Array.isArray(input) ? input : [input]).map((r) => ({
        id: `row${state.nextId++}`, status: "pending", created_at: new Date().toISOString(), ...r,
      }))
      if (table === "hubtel_payments" && state.hubtelInsertError) {
        error = state.hubtelInsertError
      } else if (table === "hubtel_payments" && inserted.some((n) => rows().some((r) => r.internal_reference === n.internal_reference && OPEN.includes(r.status)))) {
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
    auth: { getUser: async () => ({ data: { user: { id: "user1", email: "dealer@example.com" } }, error: null }) },
    rpc: async (fn: string, args: any) => {
      state.rpcCalls.push({ fn, args })
      if (state.failRpc === fn) return { data: null, error: { message: "boom" } }
      if (state.failRpc === `${fn}:ALREADY_ACTIVATED`) return { data: null, error: { message: "ALREADY_ACTIVATED" } }
      if (fn === "credit_sms_units_if_solvent") return { data: [{ outcome: "credited" }], error: null }
      if (fn === "activate_sms_account") return { data: [{ ok: true }], error: null }
      if (fn === "claim_hubtel_payment") {
        const r = (state.db.hubtel_payments ?? []).find((x) => x.reference === args.p_reference && x.status === "pending")
        if (!r) return { data: [], error: null }
        r.status = "confirming"
        r.claimed_at = "claimed"
        return { data: [{ reference: r.reference, claimed_at: r.claimed_at }], error: null }
      }
      return { data: null, error: null }
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
const chargeMobileMoney = vi.fn(async (p: any) => ({ status: "pay_offline", reference: p.reference }))
const initializePayment = vi.fn(async (p: any) => ({ authorizationUrl: "https://paystack/x", accessCode: "ac", reference: p.reference }))
vi.mock("@/lib/paystack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/paystack")>()),
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
vi.mock("@/lib/payment-gateway/read-config", () => ({
  getGatewayConfig: async () => h.state.config,
  getSurfaceConfig: async (s: string) => h.state.config.surfaces[s],
}))
vi.mock("@/lib/payment-gateway/hubtel-readiness", () => ({ isHubtelCollectionReady: () => h.state.ready }))
vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: vi.fn(async (_r: unknown, name: string) => ({ allowed: !h.state.capped.includes(name), resetAt: Date.now() })),
}))
vi.mock("@/lib/storefront-otp", () => ({
  isSmsDirectChargeEnabled: async () => h.state.directGate,
  isWalletOtpRequired: async () => h.state.otpGate,
  isPhoneOtpVerified: async () => h.state.otpVerified,
}))
vi.mock("@/lib/security-log", () => ({ logSecurityEvent: vi.fn() }))
vi.mock("@/lib/custom-domain-lookup", () => ({ resolveTrustedBaseUrl: async () => "https://www.example.com" }))
vi.mock("@/lib/sms/account-service", () => ({
  getOrCreateAccountForUser: async () => ({ id: ACCOUNT_ID_HOISTED, owner_type: "shop", status: h.state.db.__accountStatus?.[0]?.status ?? "active", mode: "platform" }),
}))
const ACCOUNT_ID_HOISTED = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
vi.mock("@/lib/sms/kill-switch", () => ({ isSmsEnabled: async () => h.state.smsEnabled, SMS_DISABLED_MESSAGE: "off" }))
vi.mock("@/lib/sms/wholesale", () => ({ getWholesaleCredits: async () => 1_000_000 }))
vi.mock("@/lib/sms/notify", () => ({ notifyAdminSmsShortfall: async () => {} }))
vi.mock("@/lib/sms/moderation-service", () => ({ writeAuditLog: async () => {} }))
// The handler's other imports, none of which an SMS payment reaches.
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(async () => {}), notifyAdmins: vi.fn(async () => {}), SMSTemplates: new Proxy({}, { get: () => () => "msg" }) }))
vi.mock("@/lib/app-settings", () => ({ getJoinCommunityLink: vi.fn(async () => null) }))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => {}), notifyAdminsPush: vi.fn(async () => {}) }))
vi.mock("@/lib/internal-url", () => ({ getInternalBaseUrl: () => "http://localhost" }))
vi.mock("@/lib/results-checker-service", () => ({ notifyAdminsNewResultsCheckRequest: vi.fn(async () => {}) }))

import { POST as purchase } from "./units/purchase/route"
import { POST as purchaseBundle } from "./units/purchase-paystack/route"
import { POST as activate } from "./activate/route"
import { confirmHubtelPayment, type HubtelPaymentStore } from "@/lib/hubtel-pay/confirm"
import { applyRateLimit } from "@/lib/rate-limiter"

const ACCOUNT = ACCOUNT_ID_HOISTED
const BUNDLE = "11111111-2222-3333-4444-555555555555"
type Surface = "wallet_topup" | "storefront" | "dashboard_direct" | "sms" | "ussd" | "whatsapp"

function config(sms?: { mode?: string; feeBearer?: string }) {
  const surfaces: Record<string, any> = {}
  for (const s of ["wallet_topup", "storefront", "dashboard_direct", "sms", "ussd", "whatsapp"] as Surface[]) {
    surfaces[s] = { gateway: "paystack", mode: "checkout", feeBearer: "customer" }
  }
  if (sms) surfaces.sms = { gateway: "hubtel", mode: sms.mode ?? "direct", feeBearer: sms.feeBearer ?? "customer" }
  return { version: 1, surfaces, hubtelFeePercent: 2 }
}

const post = (route: (r: NextRequest) => Promise<Response>, body: Record<string, unknown>) =>
  route(new NextRequest("http://x/api/sms", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok", host: "www.example.com" },
    body: JSON.stringify(body),
  }))
const buyCredits = (body: Record<string, unknown> = {}) => post(purchase, { credits: 100, paidFrom: "paystack", ...body })
const buyBundle = () => post(purchaseBundle, { bundleId: BUNDLE })
const payActivation = (body: Record<string, unknown> = {}) => post(activate, { paidFrom: "paystack", ...body })
const momo = (paymentPhone: unknown) => ({ momoDirect: true, paymentPhone })

const hubtelRows = () => h.state.db.hubtel_payments ?? []
const REFUSED = { kind: "refused", code: "4000", message: "no" }

// credits 100 × 0.04 = GHS 4.00; the bundle costs 10; activation costs 20.
beforeEach(() => {
  h.state.db = {
    sms_bundles: [{ id: BUNDLE, units: 250, price_ghs: 10, active: true, owner_type_scope: "all", mode: "platform" }],
    sms_accounts: [{ id: ACCOUNT, status: "inactive", owner_type: "shop" }],
    tenant_global_settings: [
      { key: "sms_price_per_credit", value: { amount: 0.04 } },
      { key: "sms_activation_fee", value: { amount: 20 } },
    ],
    users: [{ id: "user1", phone_number: null, phone_verified: false }],
  }
  h.state.rpcCalls = []
  h.state.config = config()
  h.state.ready = true
  h.state.otpVerified = true
  h.state.otpGate = false
  h.state.directGate = false
  h.state.smsEnabled = true
  h.state.capped = []
  h.state.hubtelReadError = null
  h.state.hubtelInsertError = null
  h.state.failRpc = null
  vi.mocked(applyRateLimit).mockClear()
  chargeMobileMoney.mockClear()
  initializePayment.mockClear()
  receiveMoney.mockReset()
  receiveMoney.mockImplementation(async () => ({ kind: "accepted" }))
  initiateCheckout.mockReset()
  initiateCheckout.mockImplementation(async () => ({ kind: "accepted", checkoutUrl: "https://pay.hubtel.com/abc" }))
})

/** The three SMS starts, each with its direct and hosted requests and what the handler should do with the money. */
const STARTS = [
  { name: "credits", hosted: () => buyCredits(), direct: (p: unknown) => buyCredits(momo(p)), price: 4, prefix: `smsqty-${ACCOUNT}-100-`, type: "sms_units_qty" },
  { name: "activation", hosted: () => payActivation(), direct: (p: unknown) => payActivation(momo(p)), price: 20, prefix: `smsactivate-${ACCOUNT}-`, type: "sms_activation" },
] as const

describe("every surface on Paystack: unchanged, through the real wrappers", () => {
  it("credits, hosted", async () => {
    const res = await buyCredits()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(Object.keys(json).sort()).toEqual(["authorizationUrl", "reference"])
    expect(json.authorizationUrl).toBe("https://paystack/x")
    expect(json.reference).toMatch(new RegExp(`^smsqty-${ACCOUNT}-100-\\d+$`))
    expect(initializePayment).toHaveBeenCalledTimes(1)
    expect(initializePayment.mock.calls[0][0]).toEqual({
      email: "dealer@example.com", amount: 4, reference: json.reference, purpose: "SMS Credits",
      metadata: { type: "sms_units_qty", sms_account_id: ACCOUNT, units: 100 }, channels: undefined,
    })
    expect(hubtelRows()).toHaveLength(0)
    expect(receiveMoney).not.toHaveBeenCalled()
    expect(initiateCheckout).not.toHaveBeenCalled()
  })

  it("credits, hosted with the direct gate on: channels stay stripped", async () => {
    h.state.directGate = true
    await buyCredits()
    expect((initializePayment.mock.calls[0][0] as any).channels).toEqual(["card", "bank_transfer"])
  })

  it("credits, direct: the raw number goes to Paystack as typed", async () => {
    h.state.directGate = true
    const res = await buyCredits(momo("024 123 4567"))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ success: true, momoDirect: true, reference: json.reference, status: "pay_offline", cost: 4 })
    expect(chargeMobileMoney.mock.calls[0][0]).toEqual({
      email: "dealer@example.com", amount: 4, phone: "024 123 4567", provider: "mtn", reference: json.reference,
      metadata: { type: "sms_units_qty", sms_account_id: ACCOUNT, units: 100 }, channel: "sms_credits", purpose: "SMS Credits",
    })
    expect(vi.mocked(applyRateLimit).mock.calls.filter((c) => c[1] === "momodirect_phone").map((c) => c[4])).toEqual(["mp:0241234567"])
    expect(receiveMoney).not.toHaveBeenCalled()
  })

  it("bundle, hosted", async () => {
    const res = await buyBundle()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(Object.keys(json).sort()).toEqual(["authorizationUrl", "reference"])
    expect(json.reference).toMatch(new RegExp(`^smsbundle-${ACCOUNT}-${BUNDLE}-\\d+$`))
    expect(initializePayment.mock.calls[0][0]).toEqual({
      email: "dealer@example.com", amount: 10, reference: json.reference, purpose: "SMS Bundle",
      metadata: { type: "sms_bundle", sms_account_id: ACCOUNT, units: 250, bundle_id: BUNDLE },
    })
  })

  it("activation, hosted", async () => {
    const res = await payActivation()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(Object.keys(json).sort()).toEqual(["authorizationUrl", "reference"])
    expect(initializePayment.mock.calls[0][0]).toEqual({
      email: "dealer@example.com", amount: 20, reference: json.reference, purpose: "SMS Account Activation", channels: undefined,
      metadata: { type: "sms_activation", sms_account_id: ACCOUNT, fee: 20 },
    })
  })

  it("activation, direct", async () => {
    h.state.directGate = true
    const res = await payActivation(momo("0241234567"))
    const json = await res.json()
    expect(json).toEqual({ success: true, momoDirect: true, reference: json.reference, status: "pay_offline" })
    expect(chargeMobileMoney.mock.calls[0][0]).toEqual({
      email: "dealer@example.com", amount: 20, phone: "0241234567", provider: "mtn", reference: json.reference,
      metadata: { type: "sms_activation", sms_account_id: ACCOUNT, fee: 20 }, channel: "sms_activation_momo", purpose: "SMS Account Activation",
    })
  })

  it("a failed read of open attempts on a Paystack surface proceeds as today", async () => {
    h.state.hubtelReadError = { message: "db down" }
    expect((await buyCredits()).status).toBe(200)
    expect(initializePayment).toHaveBeenCalledTimes(1)
  })

  it("the OTP gate still refuses an unverified number", async () => {
    h.state.directGate = true
    h.state.otpGate = true
    h.state.otpVerified = false
    const res = await buyCredits(momo("0241234567"))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "OTP_REQUIRED" })
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("an unknown network still gets today's 400", async () => {
    h.state.directGate = true
    const res = await buyCredits(momo("0111234567"))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Could not detect the mobile money network from that number." })
  })
})

describe.each(STARTS)("Hubtel direct: $name", (s) => {
  beforeEach(() => {
    h.state.config = config({ mode: "direct" })
    h.state.directGate = true
  })

  it.each(["0241234567", "024 123 4567", "241234567", "+233 24 123 4567", "0241234567x"])("%s => Hubtel with the canonical number at the plain price", async (phone) => {
    const res = await s.direct(phone)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, momoDirect: true, status: "pay_offline" })
    expect(json.reference.startsWith(s.prefix)).toBe(true)
    expect(receiveMoney).toHaveBeenCalledTimes(1)
    expect(receiveMoney.mock.calls[0][0]).toMatchObject({ msisdn: "233241234567", channel: "mtn-gh", amount: s.price, description: "Clingshub" })
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(hubtelRows()).toHaveLength(1)
    expect(hubtelRows()[0]).toMatchObject({ internal_reference: json.reference, surface: "sms", mode: "direct" })
    expect(hubtelRows()[0].metadata).toMatchObject({ type: s.type, sms_account_id: ACCOUNT, gateway: "hubtel" })
  })

  it("a number with no canonical form stays on Paystack, as typed", async () => {
    const res = await s.direct("024123456")
    // detectMomoProvider only reads the prefix, so a short number still goes to Paystack, as it does today.
    expect(res.status).toBe(200)
    expect(receiveMoney).not.toHaveBeenCalled()
    expect(chargeMobileMoney.mock.calls[0][0]).toMatchObject({ phone: "024123456", amount: s.price })
    expect(hubtelRows()).toHaveLength(0)
  })

  it("an unverified number => 403 and nothing sent, even with the OTP gate off", async () => {
    h.state.otpVerified = false
    const res = await s.direct("0241234567")
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "OTP_REQUIRED" })
    expect(receiveMoney).not.toHaveBeenCalled()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("the account's own verified number passes without an OTP", async () => {
    h.state.otpVerified = false
    h.state.db.users[0] = { id: "user1", phone_number: "0241234567", phone_verified: true }
    expect((await s.direct("+233241234567")).status).toBe(200)
    expect(receiveMoney).toHaveBeenCalledTimes(1)
  })

  it("the per-phone cap applies once on the canonical number, OTP gate on too", async () => {
    h.state.otpGate = true
    expect((await s.direct("+233 24 123 4567")).status).toBe(200)
    expect(vi.mocked(applyRateLimit).mock.calls.filter((c) => c[1] === "momodirect_phone").map((c) => c[4])).toEqual(["mp:0241234567"])
  })

  it("over the per-phone cap => 429 and nothing sent", async () => {
    h.state.capped = ["momodirect_phone"]
    expect((await s.direct("0241234567")).status).toBe(429)
    expect(receiveMoney).not.toHaveBeenCalled()
    expect(hubtelRows()).toHaveLength(0)
  })

  it("retry during an open attempt: the same reference, one prompt, no Paystack", async () => {
    const first = await (await s.direct("0241234567")).json()
    for (const phone of ["024 123 4567", "+233 24 123 4567"]) {
      const retry = await s.direct(phone)
      expect(retry.status).toBe(200)
      expect((await retry.json()).reference).toBe(first.reference)
    }
    expect(receiveMoney).toHaveBeenCalledTimes(1)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(hubtelRows()).toHaveLength(1)
  })

  it("retry with a number that has no canonical form => 409, no Paystack prompt beside the live one", async () => {
    await s.direct("0241234567")
    const retry = await s.direct("024123456")
    expect(retry.status).toBe(409)
    expect(await retry.json()).toMatchObject({ code: "PAYMENT_IN_PROGRESS" })
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("a failed read of open attempts on a Hubtel surface => 503, nothing started", async () => {
    h.state.hubtelReadError = { message: "db down" }
    const res = await s.direct("0241234567")
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/try again/i)
    expect(receiveMoney).not.toHaveBeenCalled()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("an attempt past its expiry no longer holds: a new reference", async () => {
    const first = await (await s.direct("0241234567")).json()
    hubtelRows()[0].expires_at = new Date(Date.now() - 1000).toISOString()
    hubtelRows()[0].created_at = new Date(Date.now() - 20 * 60_000).toISOString()
    // Two starts in the same millisecond would mint the same reference.
    await new Promise((r) => setTimeout(r, 2))
    const retry = await (await s.direct("0241234567")).json()
    expect(retry.reference).not.toBe(first.reference)
    expect(receiveMoney).toHaveBeenCalledTimes(2)
  })

  it("the surface flips to Paystack during an open attempt => 409, no second prompt", async () => {
    await s.direct("0241234567")
    h.state.config = config()
    const retry = await s.direct("0241234567")
    expect(retry.status).toBe(409)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(receiveMoney).toHaveBeenCalledTimes(1)
  })

  it("fallback after a refusal: Paystack at the price, which is what Paystack always charged here", async () => {
    receiveMoney.mockImplementation(async () => REFUSED)
    const res = await s.direct("024 123 4567")
    expect(res.status).toBe(200)
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
    const sent = chargeMobileMoney.mock.calls[0][0] as any
    expect(sent.amount).toBe(s.price)
    expect(sent.metadata.type).toBe(s.type)
    expect(sent.reference.startsWith(s.prefix)).toBe(true)
    expect(hubtelRows()[0].status).toBe("failed")
  })
})

describe.each(STARTS)("Hubtel hosted: $name", (s) => {
  beforeEach(() => { h.state.config = config({ mode: "checkout" }) })

  it("gets a Hubtel link; the row carries the reference, the metadata and where to return", async () => {
    const res = await s.hosted()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.authorizationUrl).toBe("https://pay.hubtel.com/abc")
    expect(json.reference.startsWith(s.prefix)).toBe(true)
    expect(initiateCheckout.mock.calls[0][0]).toMatchObject({ amount: s.price, description: "Clingshub" })
    expect(hubtelRows()[0]).toMatchObject({ internal_reference: json.reference, surface: "sms", mode: "checkout" })
    expect(hubtelRows()[0].metadata).toMatchObject({ type: s.type, sms_account_id: ACCOUNT, redirect_url: "https://www.example.com/dashboard/sms" })
    expect(initializePayment).not.toHaveBeenCalled()
  })

  it("the direct gate on: the hosted page stays on Paystack with MoMo stripped", async () => {
    h.state.directGate = true
    const res = await s.hosted()
    expect(res.status).toBe(200)
    expect((initializePayment.mock.calls[0][0] as any).channels).toEqual(["card", "bank_transfer"])
    expect(initiateCheckout).not.toHaveBeenCalled()
  })

  it("retry during an open attempt: the same link", async () => {
    const first = await (await s.hosted()).json()
    const retry = await s.hosted()
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ reference: first.reference, authorizationUrl: "https://pay.hubtel.com/abc" })
    expect(initiateCheckout).toHaveBeenCalledTimes(1)
    expect(hubtelRows()).toHaveLength(1)
  })

  it("Hubtel's answer is unknown => 503 try again, no fallback", async () => {
    initiateCheckout.mockImplementation(async () => ({ kind: "unknown", code: "timeout" }))
    const res = await s.hosted()
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/try again/i)
    expect(initializePayment).not.toHaveBeenCalled()
  })

  it("a paid attempt under the same reference => 409 already processing", async () => {
    const first = await (await s.hosted()).json()
    hubtelRows()[0].status = "paid"
    // Only a reused reference can hit a settled sibling, so the open-attempt read has to find a live row for it.
    h.state.db.hubtel_payments.push({ ...hubtelRows()[0], reference: "f".repeat(32), status: "pending", checkout_url: null })
    const retry = await s.hosted()
    expect(retry.status).toBe(409)
    expect(first.reference).toBeTruthy()
    expect(initializePayment).not.toHaveBeenCalled()
  })

  it("fallback after a refusal: Paystack at the same price", async () => {
    initiateCheckout.mockImplementation(async () => REFUSED)
    const res = await s.hosted()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ authorizationUrl: "https://paystack/x" })
    expect((initializePayment.mock.calls[0][0] as any).amount).toBe(s.price)
    expect(hubtelRows()[0].status).toBe("failed")
  })
})

describe("Hubtel: the bundle route", () => {
  beforeEach(() => { h.state.config = config({ mode: "checkout" }) })

  it("gets a Hubtel link with smsbundle- as the internal reference", async () => {
    const json = await (await buyBundle()).json()
    expect(json.authorizationUrl).toBe("https://pay.hubtel.com/abc")
    expect(json.reference).toMatch(new RegExp(`^smsbundle-${ACCOUNT}-${BUNDLE}-\\d+$`))
    expect(hubtelRows()[0]).toMatchObject({ internal_reference: json.reference, surface: "sms" })
    expect(hubtelRows()[0].metadata).toMatchObject({ type: "sms_bundle", sms_account_id: ACCOUNT, bundle_id: BUNDLE, units: 250 })
  })

  it("retry during an open attempt: the same link", async () => {
    const first = await (await buyBundle()).json()
    const retry = await (await buyBundle()).json()
    expect(retry).toMatchObject({ reference: first.reference, authorizationUrl: "https://pay.hubtel.com/abc" })
    expect(initiateCheckout).toHaveBeenCalledTimes(1)
  })

  it("a different bundle is a different purchase", async () => {
    await buyBundle()
    const other = "99999999-2222-3333-4444-555555555555"
    h.state.db.sms_bundles.push({ id: other, units: 50, price_ghs: 3, active: true, owner_type_scope: "all", mode: "platform" })
    const res = await post(purchaseBundle, { bundleId: other })
    expect((await res.json()).reference).toContain(other)
    expect(initiateCheckout).toHaveBeenCalledTimes(2)
  })

  it("fallback after a refusal: Paystack at the price", async () => {
    initiateCheckout.mockImplementation(async () => REFUSED)
    expect((await buyBundle()).status).toBe(200)
    expect((initializePayment.mock.calls[0][0] as any).amount).toBe(10)
  })

  it("Hubtel's answer is unknown => 503", async () => {
    initiateCheckout.mockImplementation(async () => ({ kind: "unknown", code: "timeout" }))
    expect((await buyBundle()).status).toBe(503)
    expect(initializePayment).not.toHaveBeenCalled()
  })
})

describe("a retry for different credits is a different purchase", () => {
  it("two amounts, two prompts", async () => {
    h.state.config = config({ mode: "direct" })
    h.state.directGate = true
    await buyCredits(momo("0241234567"))
    await buyCredits({ ...momo("0241234567"), credits: 200 })
    expect(receiveMoney).toHaveBeenCalledTimes(2)
  })
})

/** Confirm with the real handler: the row's own values go through confirmHubtelPayment into handleChargeSuccess. */
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
const credits = () => h.state.rpcCalls.filter((c) => c.fn === "credit_sms_units_if_solvent").map((c) => c.args)

describe("confirmHubtelPayment into the real handleChargeSuccess: the SMS branch credits", () => {
  it("credits: the requested quantity, idempotent on the smsqty- reference", async () => {
    h.state.config = config({ mode: "direct" })
    h.state.directGate = true
    const { reference } = await (await buyCredits(momo("0241234567"))).json()
    const row = hubtelRows()[0]
    // Hubtel's own charge sits on top of what was requested.
    expect(await confirmHubtelPayment(row.reference, confirmDeps(408))).toBe("fulfilled")
    expect(credits()).toEqual([expect.objectContaining({ p_account_id: ACCOUNT, p_units: 100, p_reason: "bundle_paystack", p_ref: reference })])
    expect(row.status).toBe("paid")
  })

  it("bundle: the bundle's own unit count", async () => {
    h.state.config = config({ mode: "checkout" })
    const { reference } = await (await buyBundle()).json()
    expect(await confirmHubtelPayment(hubtelRows()[0].reference, confirmDeps(1020))).toBe("fulfilled")
    expect(credits()).toEqual([expect.objectContaining({ p_account_id: ACCOUNT, p_units: 250, p_ref: reference })])
  })

  it("activation: the account is activated", async () => {
    h.state.config = config({ mode: "checkout" })
    await payActivation()
    expect(await confirmHubtelPayment(hubtelRows()[0].reference, confirmDeps(2040))).toBe("fulfilled")
    expect(h.state.rpcCalls.filter((c) => c.fn === "activate_sms_account")).toEqual([
      { fn: "activate_sms_account", args: { p_account_id: ACCOUNT, p_paid_from: "paystack" } },
    ])
  })

  it("the merchant bears the fee: less is requested from Hubtel, and the handler is told the full price", async () => {
    h.state.config = config({ mode: "direct", feeBearer: "merchant" })
    h.state.directGate = true
    await buyCredits(momo("0241234567"))
    const row = hubtelRows()[0]
    expect(row.amount_pesewas).toBe(392)
    expect(row.handler_amount_pesewas).toBe(400)
    expect(await confirmHubtelPayment(row.reference, confirmDeps(392))).toBe("fulfilled")
    expect(credits()).toHaveLength(1)
  })

  it("paid less than requested => review, nothing credited", async () => {
    h.state.config = config({ mode: "direct" })
    h.state.directGate = true
    await buyCredits(momo("0241234567"))
    expect(await confirmHubtelPayment(hubtelRows()[0].reference, confirmDeps(399))).toBe("needs_review")
    expect(credits()).toHaveLength(0)
  })
})

describe("a fallback's full price passes the handler's check, and a short Paystack payment still doesn't", () => {
  it.each([[400, 1], [408, 1], [398, 0]])("paid %i pesewas => %i credit", async (amount, expected) => {
    const { handleChargeSuccess } = await import("@/lib/payments/charge-events")
    const reference = `smsqty-${ACCOUNT}-100-1700000000000`
    await handleChargeSuccess({ reference, amount, metadata: { type: "sms_units_qty", sms_account_id: ACCOUNT, units: 100 } })
    expect(credits()).toHaveLength(expected)
  })
})

describe("an SMS payment on Hubtel that credits nothing is never marked paid", () => {
  /** A Hubtel row as a start writes it, so confirm's own checks pass and only the handler decides. */
  const seedRow = (internalReference: string, metadata: Record<string, unknown>, pesewas: number) => {
    const reference = "a".repeat(32)
    h.state.db.hubtel_payments = [{
      reference, internal_reference: internalReference, metadata: { ...metadata, gateway: "hubtel" }, surface: "sms", mode: "direct",
      amount_pesewas: pesewas, handler_amount_pesewas: null, status: "pending", created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(), claimed_at: null,
    }]
    return reference
  }
  const QTY = `smsqty-${ACCOUNT}-100-1700000000000`
  const BUNDLE_REF = `smsbundle-${ACCOUNT}-${BUNDLE}-1700000000000`
  const ACT = `smsactivate-${ACCOUNT}-1700000000000`
  const qtyMeta = { type: "sms_units_qty", sms_account_id: ACCOUNT, units: 100 }
  const bundleMeta = { type: "sms_bundle", sms_account_id: ACCOUNT, units: 250, bundle_id: BUNDLE }
  const actMeta = { type: "sms_activation", sms_account_id: ACCOUNT, fee: 20 }
  const setting = (key: string, amount: number) => { h.state.db.tenant_global_settings.find((r) => r.key === key)!.value = { amount } }

  it.each<[string, string, Record<string, unknown>, number, () => void]>([
    ["credits: the price per credit went up after the start", QTY, qtyMeta, 400, () => setting("sms_price_per_credit", 0.05)],
    ["credits: invalid quantity", QTY, { ...qtyMeta, units: 0 }, 400, () => {}],
    ["bundle: the price went up after the start", BUNDLE_REF, bundleMeta, 1000, () => { h.state.db.sms_bundles[0].price_ghs = 12 }],
    ["bundle: the bundle is gone", BUNDLE_REF, bundleMeta, 1000, () => { h.state.db.sms_bundles = [] }],
    ["activation: the fee went up after the start", ACT, actMeta, 2000, () => setting("sms_activation_fee", 25)],
    ["activation: the fee is not configured", ACT, actMeta, 2000, () => setting("sms_activation_fee", 0)],
    ["ref fallback: bundle gone", BUNDLE_REF, {}, 1000, () => { h.state.db.sms_bundles = [] }],
    ["ref fallback: bundle underpaid", BUNDLE_REF, {}, 1000, () => { h.state.db.sms_bundles[0].price_ghs = 12 }],
    ["ref fallback: credits underpaid", QTY, {}, 400, () => setting("sms_price_per_credit", 0.05)],
    ["ref fallback: unparseable bundle reference", "smsbundle-short", {}, 1000, () => {}],
    ["ref fallback: unparseable credits reference", "smsqty-short", {}, 400, () => {}],
    ["ref fallback: unparseable activation reference", "smsactivate-short", {}, 2000, () => {}],
    ["ref fallback: activation underpaid", ACT, {}, 2000, () => setting("sms_activation_fee", 25)],
  ])("%s => order_closed, so confirm parks it for review", async (_n, internal, metadata, pesewas, arrange) => {
    const ref = seedRow(internal, metadata, pesewas)
    arrange()
    expect(await confirmHubtelPayment(ref, confirmDeps(pesewas))).toBe("needs_review")
    expect(hubtelRows()[0].status).toBe("needs_review")
    expect(credits()).toHaveLength(0)
  })

  it.each<[string, string, Record<string, unknown>, number]>([
    ["credits", QTY, qtyMeta, 400],
    ["bundle", BUNDLE_REF, bundleMeta, 1000],
    ["ref fallback credits", QTY, {}, 400],
    ["ref fallback bundle", BUNDLE_REF, {}, 1000],
  ])("%s: the credit RPC fails => 500, so confirm parks it and alerts", async (_n, internal, metadata, pesewas) => {
    const ref = seedRow(internal, metadata, pesewas)
    h.state.failRpc = "credit_sms_units_if_solvent"
    expect(await confirmHubtelPayment(ref, confirmDeps(pesewas))).toBe("needs_review")
    expect(hubtelRows()[0].status).toBe("needs_review")
  })

  it.each<[string, Record<string, unknown>]>([["activation", actMeta], ["ref fallback activation", {}]])(
    "%s: the activation RPC fails => 500, so confirm parks it", async (_n, metadata) => {
      const ref = seedRow(ACT, metadata, 2000)
      h.state.failRpc = "activate_sms_account"
      expect(await confirmHubtelPayment(ref, confirmDeps(2000))).toBe("needs_review")
    },
  )

  it("an account already active is a normal repeat: fulfilled", async () => {
    const ref = seedRow(ACT, actMeta, 2000)
    h.state.failRpc = "activate_sms_account:ALREADY_ACTIVATED"
    expect(await confirmHubtelPayment(ref, confirmDeps(2000))).toBe("fulfilled")
  })
})

describe("Paystack: the SMS handler's answers keep HTTP 200", () => {
  const charge = async (reference: string, amount: number, metadata?: Record<string, unknown>) => {
    const { handleChargeSuccess } = await import("@/lib/payments/charge-events")
    const res = await handleChargeSuccess({ reference, amount, metadata, id: 1 })
    return { status: res!.status, body: await res!.json() }
  }
  const QTY = `smsqty-${ACCOUNT}-100-1700000000000`

  it("a failed credit: 200, body as today", async () => {
    h.state.failRpc = "credit_sms_units_if_solvent"
    expect(await charge(QTY, 400, { type: "sms_units_qty", sms_account_id: ACCOUNT, units: 100 })).toEqual({ status: 200, body: { received: true, type: "sms_units_qty" } })
  })

  it("a failed activation: 200, body as today", async () => {
    h.state.failRpc = "activate_sms_account"
    expect(await charge(`smsactivate-${ACCOUNT}-1`, 2000, { type: "sms_activation", sms_account_id: ACCOUNT, fee: 20 })).toEqual({ status: 200, body: { received: true, type: "sms_activation" } })
  })

  it("underpayment: still 200, now says nothing was delivered", async () => {
    expect(await charge(QTY, 300, { type: "sms_units_qty", sms_account_id: ACCOUNT, units: 100 })).toEqual({
      status: 200, body: { received: true, order_closed: true, type: "sms_units_qty", error: "underpayment" },
    })
  })

  it("a good payment: as today", async () => {
    expect(await charge(QTY, 400, { type: "sms_units_qty", sms_account_id: ACCOUNT, units: 100 })).toEqual({ status: 200, body: { received: true, type: "sms_units_qty" } })
    expect(credits()).toHaveLength(1)
  })
})

describe("every route that awaits a start declares its time budget", () => {
  it("maxDuration is 60", async () => {
    expect((await import("./units/purchase/route")).maxDuration).toBe(60)
    expect((await import("./units/purchase-paystack/route")).maxDuration).toBe(60)
    expect((await import("./activate/route")).maxDuration).toBe(60)
  })
})

describe("hosted SMS on a Hubtel row set to direct (I3)", () => {
  it("a bundle stays on Paystack, with no Hubtel row", async () => {
    h.state.config = config({ mode: "direct" })
    const res = await buyBundle()
    expect(res.status).toBe(200)
    expect(initializePayment).toHaveBeenCalledTimes(1)
    expect(hubtelRows()).toEqual([])
  })
})
