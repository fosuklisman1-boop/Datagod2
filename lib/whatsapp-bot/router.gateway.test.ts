// The main WhatsApp bot (waRouter) charging through the shared USSD handlers, with the REAL startMomoCharge on the
// `whatsapp` surface. Only the network edges are fakes (lib/ussd/gateway-test-kit.ts): nothing reaches a database,
// the relay, Paystack, Hubtel or WhatsApp. Bundle price 10, Paystack fee 3%: Paystack 10.30, Hubtel 10.00.
//
// WhatsApp payer rule: Hubtel only when the typed MoMo number is the sender's own (an SMS OTP verification doesn't
// count: it isn't bound to the sender); otherwise that payment is Paystack's, at the full fee, as today. The bot always asks for the number (never charges the sender).
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  afterFns: [] as Array<() => Promise<void>>,
  sessions: new Map<string, any>(),
  history: [] as Array<[string, any]>,
  charge: null as any,
  verified: new Set<string>(),
  texts: [] as Array<[string, string]>,
}))

vi.mock("@supabase/supabase-js", async () => (await import("@/lib/ussd/gateway-test-kit")).supabaseMock())
vi.mock("@/lib/payment-gateway/read-config", async () => (await import("@/lib/ussd/gateway-test-kit")).readConfigMock())
vi.mock("@/lib/payment-gateway/hubtel-readiness", async () => (await import("@/lib/ussd/gateway-test-kit")).readinessMock())
vi.mock("@/lib/hubtel-pay/client", async (orig) => (await import("@/lib/ussd/gateway-test-kit")).relayMock(await orig()))
vi.mock("@/lib/hubtel-pay/alert-throttle", async () => (await import("@/lib/ussd/gateway-test-kit")).alertMock())
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => { h.afterFns.push(fn) } }))
// The WhatsApp session and the USSD session share one key space in production (ussd:session:<id>).
vi.mock("./session", () => ({
  getWaSession: async (id: string) => h.sessions.get(id) ?? null,
  setWaSession: async (id: string, s: any) => { h.sessions.set(id, JSON.parse(JSON.stringify(s))); h.history.push([id, s]) },
  deleteWaSession: async (id: string) => { h.sessions.delete(id) },
  extendWaSession: async () => {},
}))
vi.mock("@/lib/ussd/session", () => ({
  getSession: async (id: string) => h.sessions.get(id) ?? null,
  setSession: async (id: string, s: any) => { h.sessions.set(id, JSON.parse(JSON.stringify(s))); h.history.push([id, s]) },
  deleteSession: async (id: string) => { h.sessions.delete(id) },
}))
vi.mock("@/lib/ussd/resolve-email", () => ({ resolveEmail: vi.fn(async () => "payer@example.com") }))
vi.mock("@/lib/ussd/wallet-balance", () => ({ liveWalletBalance: vi.fn(async () => undefined) }))
vi.mock("@/lib/ussd/fulfill", () => ({ fulfillUssdOrder: vi.fn() }))
vi.mock("@/lib/paystack", async (orig) => ({
  ...(await orig<object>()),
  chargeMobileMoney: vi.fn(async (p: any) => h.charge(p)),
  submitOtp: vi.fn(),
}))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(async () => {}), SMSTemplates: { ussdOtpRequired: () => "otp" } }))
vi.mock("./send", () => ({ sendWhatsAppText: vi.fn(async (to: string, body: string) => { h.texts.push([to, body]); return null }) }))
vi.mock("@/lib/app-settings", () => ({ getJoinCommunityLink: vi.fn(async () => "") }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn(async () => ({ enabled: false, map: {} })) }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({ isRecipientBlocked: vi.fn(async () => false), RECIPIENT_BLOCKED_PROMPT: "" }))
vi.mock("@/lib/ussd-service-visibility", () => ({ getUssdServiceVisibility: vi.fn(async () => ({})) }))
vi.mock("./cashback-visibility", () => ({ whatsappBotItemsVisible: vi.fn(async () => ({})) }))
vi.mock("@/lib/ussd/resolve-dialer", () => ({ resolveDialer: vi.fn(async () => ({})) }))
vi.mock("@/lib/secure-random", () => ({ secureReference: () => "REF-001" }))
vi.mock("@/lib/ussd/bots/gate", () => ({ botMenusVisible: async () => ({}), UZO_BOT_MENUS_HIDDEN: {} }))
vi.mock("@/lib/airtime-pricing", async (orig) => ({
  ...(await orig<object>()),
  isAirtimeEnabled: vi.fn(async () => true),
  getAirtimeLimits: vi.fn(async () => ({ min: 1, max: 500 })),
  airtimeBaseFeeRate: vi.fn(async () => 5),
}))
vi.mock("@/lib/results-checker-service", () => ({
  isExamBoardEnabled: vi.fn(async () => true), getAvailableCount: vi.fn(async () => 10), getMaxQuantity: vi.fn(async () => 10),
  calculateRCPrice: vi.fn(async () => ({ unitPrice: 20, totalPaid: 40, bulkApplied: false })),
  purchaseResultsCheckerVouchers: vi.fn(), getRCBulkHint: vi.fn(async () => null),
}))
vi.mock("@/lib/storefront-otp", async (orig) => ({
  ...(await orig<object>()),
  isPhoneOtpVerified: vi.fn(async (p: string) => h.verified.has(p)),
}))

import { waRouter } from "./router"
import { chargeMobileMoney, submitOtp } from "@/lib/paystack"
import { gatewayConfig, hubtelRows, kit, resetKit, rows } from "@/lib/ussd/gateway-test-kit"

const FROM = "233244123456"
const OWN = "0244123456"
const OTHER = "0551234567"
const paystackPrice = 10.3

const atConfirm = (over: Record<string, unknown> = {}) => h.sessions.set(FROM, {
  step: "CONFIRM", network: "MTN", paystackProvider: "mtn", bundleId: "p1", bundleSize: "1GB", bundlePrice: 10,
  recipientPhone: "0201234567", dialingPhone: OWN, effectivePriceTier: "regular", ...over,
})

/** The customer picks MoMo on the confirm screen, then types the number to charge. Returns every reply. */
async function payByMomo(typed: string): Promise<string[]> {
  return [await waRouter(FROM, "2"), await waRouter(FROM, typed)]
}

async function runAfter() {
  const done = Promise.all(h.afterFns.splice(0).map((f) => f()))
  await vi.advanceTimersByTimeAsync(5000)
  await done
}
const order = () => rows("ussd_orders")[0]

/** No customer-facing text names a gateway. */
function expectNeutral(replies: string[]) {
  for (const m of [...replies, ...h.texts.map(([, b]) => b)]) expect(m).not.toMatch(/hubtel|paystack/i)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetKit()
  h.afterFns = []
  h.sessions.clear()
  h.history = []
  h.verified.clear()
  h.texts = []
  h.charge = async (p: any) => ({ status: "pay_offline", reference: p.reference })
  vi.mocked(chargeMobileMoney).mockClear()
  vi.mocked(submitOtp).mockReset()
  vi.mocked(submitOtp).mockImplementation(async (reference: string) => ({ status: "pending", reference }) as any)
  kit.db.packages = [{ id: "p1", price: 10, dealer_price: 8, is_available: true }]
  kit.db.app_settings = [{ key: null, paystack_fee_percentage: 3 }]
})

describe("main WhatsApp bot, bundles, every surface on Paystack (unchanged)", () => {
  it("the typed number is charged price + fee with today's params; no Hubtel row", async () => {
    atConfirm()
    const replies = await payByMomo(OTHER)
    expect(replies[1]).toContain(`MoMo prompt sent to ${OTHER}`)
    expect(order().amount).toBeCloseTo(paystackPrice, 2)
    await runAfter()
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toEqual({
      email: "payer@example.com", amount: order().amount, phone: OTHER, provider: "mtn", reference: order().id,
      metadata: { source: "ussd", ussd_order_id: order().id, recipient_phone: "0201234567", network: "MTN", package_size: "1GB" },
    })
    expect(hubtelRows()).toHaveLength(0)
    expect(kit.receive).not.toHaveBeenCalled()
    expectNeutral(replies)
  })

  it("the sender's own number on Paystack: price + fee, as today", async () => {
    atConfirm()
    await payByMomo(OWN)
    await runAfter()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toMatchObject({ phone: OWN, amount: order().amount })
    expect(order().amount).toBeCloseTo(paystackPrice, 2)
  })

  it("an OTP-verified number on a Paystack surface reads no verification and pays price + fee", async () => {
    h.verified.add(OTHER)
    atConfirm()
    await payByMomo(OTHER)
    await runAfter()
    expect(order().amount).toBeCloseTo(paystackPrice, 2)
    expect(kit.receive).not.toHaveBeenCalled()
  })

  it("a Paystack error still fails the order", async () => {
    h.charge = async () => { throw new Error("Paystack charge failed (HTTP 400)") }
    atConfirm()
    await payByMomo(OTHER)
    await runAfter()
    expect(order()).toMatchObject({ order_status: "failed", payment_status: "failed" })
  })
})

// The chat is keyed by the sender (233...), while the router overwrites session.dialingPhone with the typed number.
// The OTP hand-off must land in the sender's chat whoever pays, or the customer's code never reaches SUBMIT_OTP.
describe("main WhatsApp bot, Paystack asks for an OTP: the customer's next message completes it", () => {
  const atAirtime = () => h.sessions.set(FROM, {
    step: "AIRTIME_CONFIRM", dialingPhone: OWN, airtimeRecipient: "0201234567", airtimeNetwork: "MTN",
    airtimeAmount: 10.5, airtimeFee: 0.5, airtimeToDeliver: 10,
  })
  const atVouchers = () => h.sessions.set(FROM, { step: "RC_CONFIRM", dialingPhone: OWN, rcBoard: "WASSCE", rcQty: 2, rcTotal: 40 })
  const SITES = [
    { name: "bundle confirm", start: () => atConfirm(), table: "ussd_orders", pendingTable: undefined },
    { name: "bundle via the payment-method screen", start: () => atConfirm({ userId: "u1", walletBalance: 50 }), table: "ussd_orders", pendingTable: undefined },
    { name: "airtime", start: atAirtime, table: "airtime_orders", pendingTable: "airtime_orders" },
    { name: "vouchers", start: atVouchers, table: "results_checker_orders", pendingTable: "results_checker_orders" },
  ]

  beforeEach(() => { h.charge = async (p: any) => ({ status: "send_otp", reference: p.reference }) })

  describe.each(SITES)("$name", ({ start, table, pendingTable }) => {
    describe.each([
      { payer: "the sender's own number", typed: OWN },
      { payer: "someone else's number", typed: OTHER },
    ])("paid from $payer", ({ typed }) => {
      it("the session and the text go to the sender, never the typed number", async () => {
        start()
        await payByMomo(typed)
        await runAfter()
        const o = rows(table)[0]
        expect(o.payment_status).toBe("otp_required")
        const s = h.sessions.get(FROM)
        expect(s).toMatchObject({ step: "SUBMIT_OTP", pendingOrderId: o.id, dialingPhone: typed })
        expect(s.pendingOrderTable).toBe(pendingTable)
        expect(h.sessions.has(typed)).toBe(false)
        expect(h.texts).toHaveLength(1)
        expect(h.texts[0][0]).toBe(FROM)
        expect(h.texts[0][1]).toMatch(/one-time code/)
        expectNeutral([])
      })

      it("the next message reaches SUBMIT_OTP and submits the code for this order", async () => {
        start()
        await payByMomo(typed)
        await runAfter()
        const o = rows(table)[0]
        const reply = await waRouter(FROM, "123456")
        expect(reply).not.toMatch(/session expired/i)
        await runAfter()
        expect(submitOtp).toHaveBeenCalledTimes(1)
        expect(submitOtp).toHaveBeenCalledWith(o.id, "123456")
        expect(o.payment_status).not.toBe("failed")
        expect(h.sessions.has(FROM)).toBe(false) // one-shot, as on USSD
      })

      it("0 cancels this order", async () => {
        start()
        await payByMomo(typed)
        await runAfter()
        await waRouter(FROM, "0")
        expect(rows(table)[0].payment_status).toBe("failed")
        expect(submitOtp).not.toHaveBeenCalled()
      })
    })
  })
})

describe("main WhatsApp bot, bundles, whatsapp surface on Hubtel", () => {
  beforeEach(() => { kit.config = gatewayConfig(["whatsapp"]) })

  it("the sender's own number: Hubtel at the price without the fee, one prompt", async () => {
    atConfirm()
    const replies = await payByMomo(OWN)
    expect(order().amount).toBe(10)
    await runAfter()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(kit.receive).toHaveBeenCalledTimes(1)
    expect(kit.receive.mock.calls[0][0]).toMatchObject({ msisdn: "233244123456", channel: "mtn-gh", amount: 10, description: "Payment" })
    expect(hubtelRows()[0]).toMatchObject({ internal_reference: order().id, surface: "whatsapp", status: "pending" })
    expect(order()).toMatchObject({ payment_status: "pending", order_status: "pending" })
    expectNeutral(replies)
  })

  it("another number that passed an OTP verification: still Paystack at the full fee (verification isn't the sender's)", async () => {
    h.verified.add(OTHER)
    atConfirm()
    const replies = await payByMomo(OTHER)
    expect(order().amount).toBeCloseTo(paystackPrice, 2)
    await runAfter()
    expect(kit.receive).not.toHaveBeenCalled()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toMatchObject({ phone: OTHER, amount: order().amount })
    expectNeutral(replies)
  })

  it("an unverified other number: Paystack at the full fee, nothing sent to Hubtel", async () => {
    atConfirm()
    const replies = await payByMomo(OTHER)
    expect(order().amount).toBeCloseTo(paystackPrice, 2)
    await runAfter()
    expect(kit.receive).not.toHaveBeenCalled()
    expect(hubtelRows()).toHaveLength(0)
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toMatchObject({ phone: OTHER, amount: order().amount })
    expectNeutral(replies)
  })

  it("refused: Paystack at price + fee, the order moved to that price before the charge", async () => {
    kit.receive.mockImplementation(async () => ({ kind: "refused", code: "4000", message: "no" }))
    let amountAtCharge: number | undefined
    h.charge = async (p: any) => { amountAtCharge = Number(order().amount); return { status: "pay_offline", reference: p.reference } }
    atConfirm()
    const replies = await payByMomo(OWN)
    await runAfter()
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBeCloseTo(paystackPrice, 2)
    expect(amountAtCharge).toBeCloseTo(paystackPrice, 2)
    expect(hubtelRows()[0].status).toBe("failed")
    expect(order().payment_status).toBe("pending")
    expectNeutral(replies)
  })

  it("refused, then Paystack asks for an OTP: the follow-up asks for the code without naming a gateway", async () => {
    kit.receive.mockImplementation(async () => ({ kind: "refused", code: "4000", message: "no" }))
    h.charge = async (p: any) => ({ status: "send_otp", reference: p.reference })
    atConfirm()
    const replies = await payByMomo(OWN)
    await runAfter()
    expect(order().payment_status).toBe("otp_required")
    expect(h.sessions.get(FROM)).toMatchObject({ step: "SUBMIT_OTP", pendingOrderId: order().id, dialingPhone: OWN })
    expect(h.sessions.has(OWN)).toBe(false)
    expect(h.texts).toHaveLength(1)
    expect(h.texts[0][0]).toBe(FROM)
    expect(h.texts[0][1]).toMatch(/one-time code/)
    expectNeutral(replies)
  })

  it("unknown: the order is not failed and no second prompt goes out", async () => {
    kit.receive.mockImplementation(async () => ({ kind: "unknown", code: "timeout", message: "slow" }))
    atConfirm()
    await payByMomo(OWN)
    await runAfter()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(kit.receive).toHaveBeenCalledTimes(1)
    expect(order()).toMatchObject({ payment_status: "pending", order_status: "pending" })
    expect(hubtelRows()[0].status).toBe("pending")
  })

  it("the same order charged twice (wallet detour, MoMo again) sends one prompt", async () => {
    atConfirm({ userId: "u1", walletBalance: 50 })
    await payByMomo(OWN)
    await runAfter()
    const pm = h.history.map(([, s]) => s).find((s) => s.step === "PAYMENT_METHOD")
    expect(pm).toMatchObject({ pendingOrderId: order().id, pendingOrderAmount: { orderId: order().id, amount: 10 } })
    // The chat comes back to the payment-method screen for the same order and picks MoMo again.
    h.sessions.set(FROM, JSON.parse(JSON.stringify(pm)))
    await waRouter(FROM, "2")
    await waRouter(FROM, OWN)
    await runAfter()
    expect(rows("ussd_orders")).toHaveLength(1)
    expect(kit.receive).toHaveBeenCalledTimes(1)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(hubtelRows()).toHaveLength(1)
  })
})

// A results-check request (results_check_requests) waiting on Paystack's OTP: cancel and a refused code must close THAT
// request, never touch ussd_orders (the data-bundle table the generic handler writes).
describe("main WhatsApp bot, results-check OTP closes the request itself", () => {
  const REQ = "rcq-1"
  const atOtp = () => {
    rows("results_check_requests").push({ id: REQ, payment_status: "otp_required", status: "pending" })
    rows("ussd_orders").push({ id: REQ, order_status: "pending", payment_status: "pending" })
    h.sessions.set(FROM, { step: "SUBMIT_OTP", dialingPhone: OWN, pendingOrderId: REQ, pendingOrderTable: "results_check_requests" })
  }
  const req = () => rows("results_check_requests").find((r) => r.id === REQ)!
  const ussd = () => rows("ussd_orders").find((r) => r.id === REQ)!

  it("0 cancels the request", async () => {
    atOtp()
    await waRouter(FROM, "0")
    expect(req()).toMatchObject({ payment_status: "failed", status: "failed" })
    expect(ussd()).toMatchObject({ order_status: "pending", payment_status: "pending" })
  })

  it("a refused code fails the request", async () => {
    atOtp()
    vi.mocked(submitOtp).mockResolvedValueOnce({ status: "failed" } as any)
    await waRouter(FROM, "123456")
    await runAfter()
    expect(submitOtp).toHaveBeenCalledWith(REQ, "123456")
    expect(req()).toMatchObject({ payment_status: "failed", status: "failed" })
    expect(ussd()).toMatchObject({ order_status: "pending", payment_status: "pending" })
  })
})

describe("main WhatsApp bot, results-check OTP step: a paid request is recognised", () => {
  it("a non-OTP message after the request is paid says approved", async () => {
    rows("results_check_requests").push({ id: "rcq-2", payment_status: "paid", status: "pending" })
    h.sessions.set(FROM, { step: "SUBMIT_OTP", dialingPhone: OWN, pendingOrderId: "rcq-2", pendingOrderTable: "results_check_requests" })
    expect(await waRouter(FROM, "done")).toMatch(/approved/)
  })
})

// AFA on WhatsApp: when Paystack asks for an OTP the chat must wait for it, or the customer dead-ends with an order
// that can never be paid. The AFA success handler needs payment_status 'pending', so the OTP step leaves it there.
describe("main WhatsApp bot, AFA: Paystack asks for an OTP", () => {
  const atAfa = () => h.sessions.set(FROM, {
    step: "AFA_CONFIRM_AFA", dialingPhone: OWN, afaFullName: "Ama Mensah", afaGhCard: "GHA-123456789-0",
    afaLocation: "Kumasi", afaRegion: "Ashanti", afaPrice: 20,
  })
  beforeEach(() => { h.charge = async (p: any) => ({ status: "send_otp", reference: p.reference }) })
  const afa = () => rows("ussd_afa_orders")[0]

  it("the chat waits on SUBMIT_OTP for this order and the sender is asked for the code", async () => {
    atAfa()
    await waRouter(FROM, "1")
    await runAfter()
    expect(h.sessions.get(FROM)).toMatchObject({ step: "SUBMIT_OTP", pendingOrderId: afa().id, pendingOrderTable: "ussd_afa_orders" })
    expect(h.texts.at(-1)?.[0]).toBe(FROM)
    expect(h.texts.at(-1)?.[1]).toMatch(/one-time code/)
    expect(afa().payment_status).toBe("pending")
  })

  it("the code is submitted for this order and the order stays payable", async () => {
    atAfa()
    await waRouter(FROM, "1")
    await runAfter()
    await waRouter(FROM, "123456")
    await runAfter()
    expect(submitOtp).toHaveBeenCalledWith(afa().id, "123456")
    expect(afa().payment_status).toBe("pending")
    expect(rows("ussd_orders")).toHaveLength(0)
  })

  it("0 cancels the AFA order itself", async () => {
    atAfa()
    await waRouter(FROM, "1")
    await runAfter()
    await waRouter(FROM, "0")
    expect(afa()).toMatchObject({ payment_status: "failed", order_status: "failed" })
  })

  it("pay_offline: unchanged, no OTP step", async () => {
    h.charge = async (p: any) => ({ status: "pay_offline", reference: p.reference })
    atAfa()
    await waRouter(FROM, "1")
    await runAfter()
    expect(h.sessions.get(FROM)?.step).not.toBe("SUBMIT_OTP")
  })
})
