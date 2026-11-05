// The WhatsApp SHOP bot's own charge sites (shopWaRouter: data CONFIRM, AIRTIME_CONFIRM, RC_CONFIRM,
// RCCHECK_CONFIRM) with the REAL startMomoCharge on the `whatsapp` surface. Only the network edges are fakes
// (lib/ussd/gateway-test-kit.ts): nothing reaches a database, the relay, Paystack, Hubtel or WhatsApp.
//
// Payer rule: Hubtel only when the typed MoMo number is the sender's own. Any other number pays on Paystack at the
// full fee, even one with an SMS OTP verification (it isn't bound to the sender: isPhoneOtpVerified answers true for
// everyone here, and must never be consulted). Data: price 10, Paystack fee 3% => Paystack 10.30, Hubtel 10.00.
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  sessions: new Map<string, any>(),
  charge: null as any,
  texts: [] as Array<[string, string]>,
  quote: null as any,
  verified: vi.fn(async () => true),
  redisKeys: new Map<string, string>(),
  redisDown: false,
  redisDelFails: false,
  staleOnce: null as any,
}))

// The claim runs against a fake Redis with real SET NX semantics (read at import, so set before the imports below).
vi.hoisted(() => {
  process.env.UPSTASH_REDIS_REST_URL = "https://example.invalid"
  process.env.UPSTASH_REDIS_REST_TOKEN = "test"
})
vi.mock("@upstash/redis", () => ({
  Redis: class {
    async set(k: string, v: string, o: any) {
      if (h.redisDown) throw new Error("redis down")
      if (o?.nx && h.redisKeys.has(k)) return null
      h.redisKeys.set(k, v)
      return "OK"
    }
    async del(k: string) {
      if (h.redisDelFails) throw new Error("redis down")
      h.redisKeys.delete(k)
      return 1
    }
    async get() { return null }
    async setex() { return "OK" }
    async expire() { return 1 }
  },
}))

vi.mock("@supabase/supabase-js", async () => (await import("@/lib/ussd/gateway-test-kit")).supabaseMock())
vi.mock("@/lib/payment-gateway/read-config", async () => (await import("@/lib/ussd/gateway-test-kit")).readConfigMock())
vi.mock("@/lib/payment-gateway/hubtel-readiness", async () => (await import("@/lib/ussd/gateway-test-kit")).readinessMock())
vi.mock("@/lib/hubtel-pay/client", async (orig) => (await import("@/lib/ussd/gateway-test-kit")).relayMock(await orig()))
vi.mock("@/lib/hubtel-pay/alert-throttle", async () => (await import("@/lib/ussd/gateway-test-kit")).alertMock())
vi.mock("./shop-session", () => ({
  getSession: async (id: string) => {
    if (h.staleOnce) { const s = h.staleOnce; h.staleOnce = null; return s }
    const s = h.sessions.get(id)
    return s ? JSON.parse(JSON.stringify(s)) : null
  },
  setSession: async (id: string, s: any) => { h.sessions.set(id, JSON.parse(JSON.stringify(s))) },
  deleteSession: async (id: string) => { h.sessions.delete(id) },
}))
vi.mock("./session", () => ({
  getWaSession: async () => null, setWaSession: async () => { throw new Error("main WhatsApp session written") },
  deleteWaSession: async () => {}, extendWaSession: async () => {},
}))
vi.mock("./send", () => ({ sendWhatsAppText: vi.fn(async (to: string, body: string) => { h.texts.push([to, body]); return "wamid" }) }))
vi.mock("./log-message", () => ({ logMessage: vi.fn(async () => {}) }))
vi.mock("@/lib/whatsapp-bot/shop-prefs", () => ({ getShopPref: async () => null, setShopPref: async () => {}, clearShopPref: async () => {} }))
vi.mock("@/lib/shop-commerce/shop-code", () => ({
  resolveShopCode: vi.fn(async () => ({
    shopCodeId: "code-1", shopId: "shop-1", parentShopId: null, shopName: "Kofi Data", status: "active", whatsappActivated: true,
  })),
  fetchShopNetworks: async () => ["MTN"],
  getCanonicalShopName: async () => "Kofi Data",
}))
vi.mock("@/lib/shop-commerce/pricing", () => ({
  fetchShopBundles: vi.fn(),
  verifyBundlePrice: vi.fn(async () => ({ verifiedPrice: 10, profitAmount: 1, parentProfitAmount: 0 })),
  shopOwnerIsDealer: vi.fn(async () => false),
}))
// The order writers insert into the fake tables with the columns the charge and the re-price read.
vi.mock("@/lib/shop-commerce/orders", async () => {
  const { rows } = await import("@/lib/ussd/gateway-test-kit")
  const add = (table: string, row: Record<string, unknown>) => {
    const id = `${table}-${rows(table).length + 1}`
    rows(table).push({ id, ...row })
    return { orderId: id }
  }
  return {
    createShopBundleOrder: vi.fn(async (i: any) => add("ussd_shop_orders", { amount: i.chargeAmount, payment_status: "pending", order_status: "pending" })),
    createShopAirtimeOrder: vi.fn(async (i: any) => add("airtime_orders", {
      total_paid: i.totalPaid, fee_amount: i.feeAmount, payment_status: "pending_payment", status: "pending", ...(i.cashbackColumns ?? {}),
    })),
    createShopRcOrder: vi.fn(async (i: any) => add("results_checker_orders", { total_paid: i.totalPaid, payment_status: "pending_payment", status: "pending" })),
    createShopCheckResultsRequest: vi.fn(async (i: any) => add("results_check_requests", { fee: i.fee, payment_status: "pending_payment", status: "pending" })),
  }
})
vi.mock("@/lib/paystack", async (orig) => ({ ...(await orig<object>()), chargeMobileMoney: vi.fn(async (p: any) => h.charge(p)), submitOtp: vi.fn() }))
vi.mock("@/lib/ussd/resolve-email", () => ({ resolveEmail: vi.fn(async () => "cust@example.com") }))
vi.mock("@/lib/secure-random", () => ({ secureReference: () => "REF-001" }))
vi.mock("@/lib/results-checker-service", () => ({
  isExamBoardEnabled: vi.fn(async () => true), getAvailableCount: vi.fn(async () => 10), getMaxQuantity: vi.fn(async () => 10),
  calculateRCPrice: vi.fn(async () => ({ unitPrice: 20, totalPaid: 40, merchantCommission: 1, bulkApplied: false })),
  getRCBulkHint: vi.fn(async () => null),
  calculateResultsCheckPrice: vi.fn(async () => ({ totalPaid: 15, merchantCommission: 1 })),
}))
vi.mock("@/lib/ussd/handlers/results-checker", () => ({ buildRcBoardOptions: vi.fn(async () => []) }))
vi.mock("@/lib/ussd-service-visibility", () => ({
  getUssdServiceVisibility: async () => ({ data: true, afa: true, airtime: true, resultsChecker: true, cashbackAirtime: true }),
}))
vi.mock("./cashback-visibility", () => ({ whatsappBotItemsVisible: vi.fn(async () => ({ networkPlans: false, payBills: false, cashbackAirtime: true })) }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: async () => ({ enabled: false, map: {} }) }))
vi.mock("@/lib/cashback/storefront-airtime", () => ({
  quoteBotAirtime: vi.fn(async (_n: string, face: number) => (h.quote ? { ...h.quote, faceAmount: face } : null)),
}))
vi.mock("@/lib/airtime-pricing", async (orig) => ({
  ...(await orig<object>()),
  isAirtimeEnabled: vi.fn(async () => true),
  getAirtimeLimits: vi.fn(async () => ({ min: 1, max: 500 })),
  airtimeBaseFeeRate: vi.fn(async () => 5),
}))
vi.mock("@/lib/storefront-otp", async (orig) => ({ ...(await orig<object>()), isPhoneOtpVerified: h.verified }))

import { shopWaRouter } from "./shop-router"
import { chargeMobileMoney } from "@/lib/paystack"
import { gatewayConfig, hubtelRows, kit, resetKit, rows } from "@/lib/ussd/gateway-test-kit"

const FROM = "233244123456"
const OWN = "0244123456"
const OTHER = "0551234567"
const SHOP = { shopCodeId: "code-1", shopId: "shop-1", shopName: "Kofi Data" }
// Cashback airtime: payAmount 9.79 = base 9.60 + Paystack fee 0.19; Hubtel charges 9.60.
const QUOTE = {
  applied: true, faceAmount: 10, rate: 10, share: 50, commission: 1, customerCashback: 0.4, shopShare: 0.25,
  payAmount: 9.79, datagodKeeps: 0.35, provider: "hubtel", base: 9.6, paymentFee: 0.19, feeRate: 1.95,
}

const at = (s: Record<string, unknown>) => h.sessions.set(FROM, { ...SHOP, ...s })
const bundle = (pay: string) => at({
  step: "CONFIRM", network: "MTN", bundleId: "b1", bundleSize: "1GB", bundlePrice: 10, recipientPhone: "0201234567",
  paymentPhone: pay, paystackProvider: "mtn",
})
const airtime = (pay: string, cashback = false) => at({
  step: "AIRTIME_CONFIRM", airtimeNetwork: "MTN", airtimeRecipient: "0241234567", airtimeAmount: 10, airtimeToDeliver: 9.5,
  paymentPhone: pay, paystackProvider: "mtn", ...(cashback ? { airtimeCashbackPay: 9.79 } : {}),
})
const vouchers = (pay: string) => at({ step: "RC_CONFIRM", rcBoard: "WASSCE", rcQty: 2, rcTotal: 40, paymentPhone: pay, paystackProvider: "mtn" })
const check = (pay: string) => at({
  step: "RCCHECK_CONFIRM", rcCheckBoard: "WASSCE", rcCheckCandidateType: "school", rcCheckMode: "own_voucher",
  rcCheckIndex: "1234567890", rcCheckYear: "2024", rcCheckDob: "2005-01-01", rcCheckAmount: 15,
  rcCheckVoucherPin: "123456789012", rcCheckVoucherSerial: "WRC123456789", paymentPhone: pay, paystackProvider: "mtn",
})
const pay = () => shopWaRouter(FROM, "1", null)
const charged = () => vi.mocked(chargeMobileMoney).mock.calls

/** No reply or pushed text names a gateway. */
function expectNeutral(...replies: string[]) {
  for (const m of [...replies, ...h.texts.map(([, b]) => b)]) expect(m).not.toMatch(/hubtel|paystack/i)
}

beforeEach(() => {
  resetKit()
  h.sessions.clear()
  h.texts = []
  h.quote = null
  h.verified.mockClear()
  h.redisKeys.clear()
  h.redisDown = false
  h.redisDelFails = false
  h.staleOnce = null
  h.charge = async (p: any) => ({ status: "pay_offline", reference: p.reference })
  vi.mocked(chargeMobileMoney).mockClear()
  kit.db.app_settings = [{ key: null, paystack_fee_percentage: 3 }]
  kit.db.ussd_shop_codes = [{ id: "code-1", code: "1234" }]
})

describe("WhatsApp shop bot, every surface on Paystack (unchanged)", () => {
  it("data: price + fee to the typed number, today's params, no Hubtel row", async () => {
    bundle(OTHER)
    const r = await pay()
    const o = rows("ussd_shop_orders")[0]
    expect(o.amount).toBeCloseTo(10.3, 2)
    expect(charged()).toHaveLength(1)
    expect(charged()[0][0]).toEqual({
      email: "cust@example.com", amount: o.amount, phone: OTHER, provider: "mtn", reference: o.id,
      metadata: { source: "whatsapp_shop", whatsapp_shop_order_id: o.id, recipient_phone: "0201234567", network: "MTN", package_size: "1GB", shop_id: "shop-1" },
    })
    expect(hubtelRows()).toHaveLength(0)
    expect(h.sessions.get(FROM)).toEqual({ step: "AI_CONVERSATION" })
    expectNeutral(r)
  })

  it("data: the sender's own number is price + fee too", async () => {
    bundle(OWN)
    await pay()
    expect(charged()[0][0].amount).toBeCloseTo(10.3, 2)
    expect(kit.receive).not.toHaveBeenCalled()
  })

  it("data: send_otp still moves the chat to SUBMIT_OTP and marks the order", async () => {
    h.charge = async (p: any) => ({ status: "send_otp", reference: p.reference })
    bundle(OTHER)
    await pay()
    const o = rows("ussd_shop_orders")[0]
    expect(o.payment_status).toBe("otp_required")
    expect(h.sessions.get(FROM)).toMatchObject({ step: "SUBMIT_OTP", pendingOrderId: o.id, pendingOrderTable: "ussd_shop_orders" })
  })

  it("data: a Paystack error still fails the order", async () => {
    h.charge = async () => { throw new Error("Paystack charge failed (HTTP 400)") }
    bundle(OTHER)
    const r = await pay()
    expect(rows("ussd_shop_orders")[0]).toMatchObject({ order_status: "failed", payment_status: "failed" })
    expect(r).toBe("Sorry, we could not start the payment. Please try again.")
  })

  it("airtime, vouchers and results check: today's amounts and params", async () => {
    airtime(OTHER)
    await pay()
    const a = rows("airtime_orders")[0]
    expect(charged()[0][0]).toEqual({
      email: "cust@example.com", amount: 10, phone: OTHER, provider: "mtn", reference: a.id,
      metadata: { source: "whatsapp_shop_airtime", airtime_order_id: a.id, recipient_phone: "0241234567", network: "MTN", shop_id: "shop-1" },
    })
    vouchers(OTHER)
    await pay()
    const v = rows("results_checker_orders")[0]
    expect(charged()[1][0]).toEqual({
      email: "cust@example.com", amount: 40, phone: OTHER, provider: "mtn", reference: v.id,
      metadata: { source: "whatsapp_shop_results_checker", results_checker_order_id: v.id, exam_board: "WASSCE", quantity: 2, shop_id: "shop-1" },
    })
    check(OTHER)
    await pay()
    const c = rows("results_check_requests")[0]
    expect(charged()[2][0]).toEqual({
      email: "cust@example.com", amount: 15, phone: OTHER, provider: "mtn", reference: c.id,
      metadata: { source: "whatsapp_shop_results_check", results_check_request_id: c.id, exam_board: "WASSCE", mode: "own_voucher", shop_id: "shop-1" },
    })
    expect(hubtelRows()).toHaveLength(0)
  })

  it("cashback airtime: payAmount with the fee, as today", async () => {
    h.quote = QUOTE
    airtime(OTHER, true)
    await pay()
    expect(rows("airtime_orders")[0]).toMatchObject({ total_paid: 9.79, payment_fee_amount: 0.19 })
    expect(charged()[0][0].amount).toBe(9.79)
  })
})

// The session stays on the confirm step while the charge is awaited, so a second distinct "1" used to read that step
// and mint a second order and a second prompt. One per-sender claim is taken before the order, on every gateway.
describe.each([
  { gateway: "Paystack", hubtel: [] as string[] },
  { gateway: "Hubtel", hubtel: ["whatsapp"] },
])("two inbound Pay now messages at once, $gateway", ({ hubtel }) => {
  const SITES = [
    { name: "data CONFIRM", start: () => bundle(OWN), step: "CONFIRM", table: "ussd_shop_orders" },
    { name: "AIRTIME_CONFIRM", start: () => airtime(OWN), step: "AIRTIME_CONFIRM", table: "airtime_orders" },
    { name: "RC_CONFIRM", start: () => vouchers(OWN), step: "RC_CONFIRM", table: "results_checker_orders" },
    { name: "RCCHECK_CONFIRM", start: () => check(OWN), step: "RCCHECK_CONFIRM", table: "results_check_requests" },
  ]
  // True whatever became of the first request and wherever its prompt went; names no gateway.
  const BUSY = /^Please check for the payment prompt, or start again if you didn't get one\.$/
  const slow = () => new Promise((r) => setTimeout(r, 15))
  const prompts = () => charged().length + kit.receive.mock.calls.length

  beforeEach(() => {
    kit.config = gatewayConfig(hubtel)
    h.charge = async (p: any) => { await slow(); return { status: "pay_offline", reference: p.reference } }
    kit.receive.mockImplementation(async () => { await slow(); return { kind: "accepted" } })
  })

  describe.each(SITES)("$name", ({ start, step, table }) => {
    it("concurrent: exactly one order, one prompt, one sent reply; the claim is freed", async () => {
      start()
      const replies = await Promise.all([pay(), pay()])
      expect(rows(table)).toHaveLength(1)
      expect(prompts()).toBe(1)
      expect(replies.filter((r) => BUSY.test(r))).toHaveLength(1)
      expect(replies.filter((r) => r.includes(OWN))).toHaveLength(1)
      expect(h.sessions.get(FROM)).toEqual({ step: "AI_CONVERSATION" })
      expect(h.redisKeys.size).toBe(0)
      expectNeutral(...replies)
    })

    it("a second message mid-charge changes nothing; the first request's session write stands", async () => {
      start()
      const before = h.sessions.get(FROM)
      const first = pay()
      await new Promise((r) => setTimeout(r, 5)) // the first holds the claim and is inside the charge
      expect(await pay()).toMatch(BUSY)
      expect(h.sessions.get(FROM)).toEqual(before)
      expect(await first).toContain(OWN)
      expect(h.sessions.get(FROM)).toEqual({ step: "AI_CONVERSATION" })
      expect(rows(table)).toHaveLength(1)
      expect(prompts()).toBe(1)
    })

    it("a message that read the confirm step just before the first finished finds it gone: no order, no prompt", async () => {
      start()
      const stale = h.sessions.get(FROM)
      await pay()
      h.staleOnce = stale
      expect(await pay()).toMatch(BUSY)
      expect(rows(table)).toHaveLength(1)
      expect(prompts()).toBe(1)
      expect(h.sessions.get(FROM)).toEqual({ step: "AI_CONVERSATION" })
      expect(h.redisKeys.size).toBe(0)
    })

    it("a later purchase after the hand-off isn't blocked", async () => {
      start()
      await pay()
      start()
      expect(await pay()).toContain(OWN)
      expect(rows(table)).toHaveLength(2)
      expect(prompts()).toBe(2)
    })

    it("Redis down: nothing is created or charged, the chat stays on the step and can retry", async () => {
      start()
      h.redisDown = true
      const r = await pay()
      expect(r).toBe("Sorry, we could not start the payment right now. Please try again in a moment.")
      expect(rows(table)).toHaveLength(0)
      expect(prompts()).toBe(0)
      expect(h.sessions.get(FROM).step).toBe(step)
      h.redisDown = false
      expect(await pay()).toContain(OWN)
      expect(rows(table)).toHaveLength(1)
    })

    it("a failed release doesn't break the reply", async () => {
      start()
      h.redisDelFails = true
      expect(await pay()).toContain(OWN)
      expect(h.sessions.get(FROM)).toEqual({ step: "AI_CONVERSATION" })
    })
  })

  it("the claim is freed when the charge step fails, and when the order writer throws", async () => {
    h.charge = async () => { throw new Error("Paystack charge failed (HTTP 400)") }
    kit.receive.mockImplementation(async () => { throw new Error("relay blew up") })
    bundle(OWN)
    await pay()
    expect(h.redisKeys.size).toBe(0)

    const { createShopBundleOrder } = await import("@/lib/shop-commerce/orders")
    vi.mocked(createShopBundleOrder).mockRejectedValueOnce(new Error("db down"))
    bundle(OWN)
    await expect(pay()).rejects.toThrow("db down")
    expect(h.redisKeys.size).toBe(0)
  })

  it("the claim is per sender: another customer's payment goes through at the same time", async () => {
    const OTHER_SENDER = "233201234567"
    bundle(OWN)
    h.sessions.set(OTHER_SENDER, { ...h.sessions.get(FROM), paymentPhone: "0201234567", paystackProvider: "vod" })
    await Promise.all([pay(), shopWaRouter(OTHER_SENDER, "1", null)])
    expect(rows("ussd_shop_orders")).toHaveLength(2)
    expect(prompts()).toBe(2)
  })

  it("a charge asking for an OTP keeps SUBMIT_OTP; the second message doesn't undo it", async () => {
    h.charge = async (p: any) => { await slow(); return { status: "send_otp", reference: p.reference } }
    kit.receive.mockImplementation(async () => { await slow(); return { kind: "refused", code: "4000", message: "no" } })
    bundle(OWN)
    await Promise.all([pay(), pay()])
    const o = rows("ussd_shop_orders")
    expect(o).toHaveLength(1)
    expect(h.sessions.get(FROM)).toMatchObject({ step: "SUBMIT_OTP", pendingOrderId: o[0].id })
  })
})

describe("WhatsApp shop bot, whatsapp surface on Hubtel", () => {
  beforeEach(() => { kit.config = gatewayConfig(["whatsapp"]) })

  it("data, the sender's own number: Hubtel at the price without the fee, one prompt", async () => {
    bundle(OWN)
    const r = await pay()
    const o = rows("ussd_shop_orders")[0]
    expect(o.amount).toBe(10)
    expect(charged()).toHaveLength(0)
    expect(kit.receive).toHaveBeenCalledTimes(1)
    expect(kit.receive.mock.calls[0][0]).toMatchObject({ msisdn: "233244123456", channel: "mtn-gh", amount: 10, description: "Payment" })
    expect(hubtelRows()[0]).toMatchObject({ internal_reference: o.id, surface: "whatsapp", status: "pending" })
    expect(o).toMatchObject({ payment_status: "pending", order_status: "pending" })
    expect(r).toContain(OWN)
    expectNeutral(r)
  })

  it("data, another number (OTP-verified or not): Paystack at the full fee, no verification lookup", async () => {
    bundle(OTHER)
    const r = await pay()
    const o = rows("ussd_shop_orders")[0]
    expect(o.amount).toBeCloseTo(10.3, 2)
    expect(kit.receive).not.toHaveBeenCalled()
    expect(charged()[0][0]).toMatchObject({ phone: OTHER, amount: o.amount })
    expect(h.verified).not.toHaveBeenCalled()
    expectNeutral(r)
  })

  it("data refused: Paystack at price + fee, the order moved to that price first", async () => {
    kit.receive.mockImplementation(async () => ({ kind: "refused", code: "4000", message: "no" }))
    let amountAtCharge: number | undefined
    h.charge = async (p: any) => { amountAtCharge = Number(rows("ussd_shop_orders")[0].amount); return { status: "pay_offline", reference: p.reference } }
    bundle(OWN)
    const r = await pay()
    expect(charged()).toHaveLength(1)
    expect(charged()[0][0].amount).toBeCloseTo(10.3, 2)
    expect(amountAtCharge).toBeCloseTo(10.3, 2)
    expect(hubtelRows()[0].status).toBe("failed")
    expectNeutral(r)
  })

  it("data refused and the order can't be re-priced: nothing charged, the order failed", async () => {
    kit.receive.mockImplementation(async () => {
      rows("ussd_shop_orders")[0].amount = 12 // changed under us: the guarded write matches nothing
      return { kind: "refused", code: "4000", message: "no" }
    })
    bundle(OWN)
    const r = await pay()
    expect(charged()).toHaveLength(0)
    expect(rows("ussd_shop_orders")[0].payment_status).toBe("failed")
    expect(r).toBe("Sorry, we could not start the payment. Please try again.")
  })

  it("data refused, then Paystack asks for an OTP: the chat waits on SUBMIT_OTP", async () => {
    kit.receive.mockImplementation(async () => ({ kind: "refused", code: "4000", message: "no" }))
    h.charge = async (p: any) => ({ status: "send_otp", reference: p.reference })
    bundle(OWN)
    const r = await pay()
    const o = rows("ussd_shop_orders")[0]
    expect(o.payment_status).toBe("otp_required")
    expect(h.sessions.get(FROM)).toMatchObject({ step: "SUBMIT_OTP", pendingOrderId: o.id, pendingOrderTable: "ussd_shop_orders" })
    expectNeutral(r)
  })

  it("data unknown: no failure, no Paystack, the prompt-sent reply", async () => {
    kit.receive.mockImplementation(async () => ({ kind: "unknown", code: "timeout", message: "slow" }))
    bundle(OWN)
    const r = await pay()
    expect(charged()).toHaveLength(0)
    expect(rows("ussd_shop_orders")[0]).toMatchObject({ payment_status: "pending", order_status: "pending" })
    expect(hubtelRows()[0].status).toBe("pending")
    expect(r).toContain(OWN)
    expect(h.sessions.get(FROM)).toEqual({ step: "AI_CONVERSATION" })
  })

  it("a repeat Pay now after the hand-off never charges again", async () => {
    bundle(OWN)
    await pay()
    expect(await pay()).toBe("") // the closed chat is with the AI now: no order, no prompt
    expect(rows("ussd_shop_orders")).toHaveLength(1)
    expect(kit.receive).toHaveBeenCalledTimes(1)
    expect(charged()).toHaveLength(0)
  })

  it("cashback airtime, own number: the order drops the Paystack fee and Hubtel charges the base", async () => {
    h.quote = QUOTE
    airtime(OWN, true)
    const r = await pay()
    expect(rows("airtime_orders")[0]).toMatchObject({ total_paid: 9.6, payment_fee_amount: 0 })
    expect(kit.receive.mock.calls[0][0]).toMatchObject({ msisdn: "233244123456", amount: 9.6 })
    expect(charged()).toHaveLength(0)
    expectNeutral(r)
  })

  it("cashback airtime refused: Paystack at payAmount with the fee restored first", async () => {
    h.quote = QUOTE
    kit.receive.mockImplementation(async () => ({ kind: "refused", code: "4000", message: "no" }))
    let atCharge: any
    h.charge = async (p: any) => { atCharge = { ...rows("airtime_orders")[0] }; return { status: "pay_offline", reference: p.reference } }
    airtime(OWN, true)
    await pay()
    expect(charged()[0][0].amount).toBe(9.79)
    expect(atCharge).toMatchObject({ total_paid: 9.79, payment_fee_amount: 0.19 })
  })

  it("cashback airtime, another number: Paystack at payAmount", async () => {
    h.quote = QUOTE
    airtime(OTHER, true)
    await pay()
    expect(rows("airtime_orders")[0]).toMatchObject({ total_paid: 9.79, payment_fee_amount: 0.19 })
    expect(kit.receive).not.toHaveBeenCalled()
    expect(charged()[0][0].amount).toBe(9.79)
  })

  it("legacy airtime: own number on Hubtel, another number on Paystack, same amount", async () => {
    airtime(OWN)
    await pay()
    expect(kit.receive.mock.calls[0][0]).toMatchObject({ msisdn: "233244123456", amount: 10 })
    airtime(OTHER)
    await pay()
    expect(kit.receive).toHaveBeenCalledTimes(1)
    expect(charged()[0][0]).toMatchObject({ phone: OTHER, amount: 10 })
  })

  it("vouchers: own number on Hubtel, another number on Paystack, same amount", async () => {
    vouchers(OWN)
    const r = await pay()
    expect(kit.receive.mock.calls[0][0]).toMatchObject({ msisdn: "233244123456", amount: 40 })
    expect(hubtelRows()[0]).toMatchObject({ internal_reference: rows("results_checker_orders")[0].id, surface: "whatsapp" })
    vouchers(OTHER)
    await pay()
    expect(kit.receive).toHaveBeenCalledTimes(1)
    expect(charged()[0][0]).toMatchObject({ phone: OTHER, amount: 40 })
    expectNeutral(r)
  })

  it("results check: own number on Hubtel, another number on Paystack, same amount", async () => {
    check(OWN)
    const r = await pay()
    expect(kit.receive.mock.calls[0][0]).toMatchObject({ msisdn: "233244123456", amount: 15 })
    expect(hubtelRows()[0]).toMatchObject({ internal_reference: rows("results_check_requests")[0].id, surface: "whatsapp" })
    check(OTHER)
    await pay()
    expect(kit.receive).toHaveBeenCalledTimes(1)
    expect(charged()[0][0]).toMatchObject({ phone: OTHER, amount: 15 })
    expectNeutral(r)
  })

  it("results check unknown: the request is not failed", async () => {
    kit.receive.mockImplementation(async () => ({ kind: "unknown", code: "timeout", message: "slow" }))
    check(OWN)
    await pay()
    expect(rows("results_check_requests")[0]).toMatchObject({ payment_status: "pending_payment", status: "pending" })
    expect(charged()).toHaveLength(0)
  })
})
