// Router-level tests: airtime on the WhatsApp SHOP bot (shopWaRouter's own airtime implementation).
// - The "legacy" block pins today's messages, the createShopAirtimeOrder input (shop markup pricing, merchant
//   commission) and the MoMo charge byte for byte. It was written (and run green) BEFORE the cashback change and must
//   stay green with the WhatsApp cashbackAirtime switch off, and with it on while the quote is unusable.
// - Cashback (switch on + usable quote, rail paystack, shop: true): storefront shares; merchant_commission = shopShare;
//   MoMo charge = total_paid = payAmount to the typed number (reference = order id); fee_amount 0, fee in
//   payment_fee_amount; >2 decimals refused; the shop is re-checked before the order; a re-quote mismatch at confirm =>
//   "Price changed. Please try again." and no order.
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    sessions: new Map<string, any>(),
    vis: { networkPlans: false, payBills: false, cashbackAirtime: false },
    shop: {
      shopCodeId: "code-1", shopId: "shop-1", parentShopId: "parent-1", shopName: "Kofi Data",
      status: "active", whatsappActivated: true,
    } as Record<string, unknown>,
    markup: 2 as number, // user_shops.airtime_markup_mtn
    quote: null as any,  // what quoteBotAirtime returns (null = cashback not applied)
    quoteCalls: [] as any[],
    updates: [] as Array<{ table: string; patch: any }>,
  }
  const db = {
    from(table: string) {
      let op = "select"
      const chain: any = new Proxy({}, {
        get(_t, prop) {
          if (prop === "update") return (patch: any) => { op = "update"; state.updates.push({ table, patch }); return chain }
          if (prop === "maybeSingle" || prop === "single") {
            return async () => {
              if (table === "ussd_shop_codes") return { data: { code: "1234" }, error: null }
              if (table === "user_shops" && op === "select") return { data: { airtime_markup_mtn: state.markup }, error: null }
              return { data: null, error: null }
            }
          }
          if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: null, error: null })
          return () => chain
        },
      })
      return chain
    },
    rpc: async () => ({ data: false, error: null }),
  }
  return {
    state, db,
    vis: vi.fn(async () => ({ ...state.vis })),
    resolveShopCode: vi.fn(async () => ({ ...state.shop })),
    createShopAirtimeOrder: vi.fn(async (_i: any): Promise<any> => ({ orderId: "at-order-1" })),
    chargeMobileMoney: vi.fn(async (_i: any): Promise<any> => ({ status: "pay_offline" })),
  }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.db }))
vi.mock("./shop-session", () => ({
  getSession: async (id: string) => h.state.sessions.get(id) ?? null,
  setSession: async (id: string, s: any) => { h.state.sessions.set(id, JSON.parse(JSON.stringify(s))) },
  deleteSession: async (id: string) => { h.state.sessions.delete(id) },
}))
vi.mock("./session", () => ({
  getWaSession: async () => null, setWaSession: async () => { throw new Error("main WhatsApp session written") },
  deleteWaSession: async () => {}, extendWaSession: async () => {},
}))
vi.mock("./send", () => ({ sendWhatsAppText: vi.fn(async () => "wamid") }))
vi.mock("./log-message", () => ({ logMessage: vi.fn(async () => {}) }))
vi.mock("@/lib/whatsapp-bot/shop-prefs", () => ({ getShopPref: async () => null, setShopPref: async () => {}, clearShopPref: async () => {} }))
vi.mock("@/lib/shop-commerce/shop-code", () => ({
  resolveShopCode: h.resolveShopCode, fetchShopNetworks: async () => ["MTN"], getCanonicalShopName: async () => "Kofi Data",
}))
vi.mock("@/lib/shop-commerce/pricing", () => ({ fetchShopBundles: vi.fn(), verifyBundlePrice: vi.fn(), shopOwnerIsDealer: vi.fn(async () => false) }))
vi.mock("@/lib/shop-commerce/orders", () => ({
  createShopBundleOrder: vi.fn(), createShopAirtimeOrder: h.createShopAirtimeOrder, createShopRcOrder: vi.fn(), createShopCheckResultsRequest: vi.fn(),
}))
vi.mock("@/lib/paystack", () => ({ chargeMobileMoney: h.chargeMobileMoney, submitOtp: vi.fn() }))
vi.mock("@/lib/ussd/resolve-email", () => ({ resolveEmail: vi.fn(async () => "cust@example.com") }))
vi.mock("@/lib/secure-random", () => ({ secureReference: () => "AT-REF-001" }))
vi.mock("@/lib/results-checker-service", () => ({
  isExamBoardEnabled: vi.fn(), getAvailableCount: vi.fn(), getMaxQuantity: vi.fn(), calculateRCPrice: vi.fn(),
  getRCBulkHint: vi.fn(), calculateResultsCheckPrice: vi.fn(),
}))
vi.mock("@/lib/ussd/handlers/results-checker", () => ({ buildRcBoardOptions: vi.fn() }))
vi.mock("@/lib/ussd-service-visibility", () => ({
  getUssdServiceVisibility: async () => ({ data: true, afa: true, airtime: true, resultsChecker: true, cashbackAirtime: true }),
}))
vi.mock("./cashback-visibility", () => ({ whatsappBotItemsVisible: h.vis }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: async () => ({ enabled: false, map: {} }) }))
vi.mock("@/lib/cashback/storefront-airtime", () => ({
  quoteBotAirtime: vi.fn(async (network: string, face: number, opts: any) => {
    h.state.quoteCalls.push([network, face, opts])
    const q = typeof h.state.quote === "function" ? h.state.quote(face) : h.state.quote
    return q ? { ...q } : null
  }),
}))
vi.mock("@/lib/airtime-pricing", async (orig) => ({
  ...(await orig<typeof import("@/lib/airtime-pricing")>()),
  isAirtimeEnabled: vi.fn(async () => true),
  getAirtimeLimits: vi.fn(async () => ({ min: 1, max: 500 })),
  airtimeBaseFeeRate: vi.fn(async () => 5),
}))

import { shopWaRouter } from "./shop-router"

const FROM = "233244123456" // the WhatsApp sender (Meta's wa_id)
const PAY = "0201234567"    // the typed MoMo number (Telecel => Paystack "vod")
const RECIPIENT = "0241234567"
const SHOP = "Kofi Data"

const RECIPIENT_PROMPT = `${SHOP}\nBuy Airtime\nEnter recipient number:\n\n0. Back`
const AMOUNT_PROMPT = "MTN Airtime\nEnter amount to pay\n(GHS 1 - 500):\n\n0. Back"
const MOMO_PROMPT = "Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel"
// 20 at 5% base + 2% shop markup: fee 1.31, delivered 18.69, commission 0.37.
const LEGACY_CONFIRM = `${SHOP}\nMTN to 0241234567\nPay GHS 20.00\nGet GHS 18.69\nfrom ${PAY}\n\n1. Pay now\n2. Cancel`
const SENT = `MoMo prompt sent to ${PAY}. Approve to complete.\n\nIf you receive an OTP code, reply here with it.`
const CLOSED = "This shop is currently unavailable. Please contact the seller."

const LEGACY_ORDER = {
  referenceCode: "AT-REF-001",
  network: "MTN",
  beneficiaryPhone: RECIPIENT,
  airtimeAmount: 18.69,
  feeAmount: 1.31,
  totalPaid: 20,
  shopId: "shop-1",
  merchantCommission: 0.37,
  dialingPhone: FROM,
  channel: "whatsapp_shop",
  customerName: "WhatsApp Customer",
  customerEmail: "cust@example.com",
}
const LEGACY_CHARGE = {
  email: "cust@example.com",
  amount: 20,
  phone: PAY,
  provider: "vod",
  reference: "at-order-1",
  metadata: { source: "whatsapp_shop_airtime", airtime_order_id: "at-order-1", recipient_phone: RECIPIENT, network: "MTN", shop_id: "shop-1" },
}

const session = () => h.state.sessions.get(FROM)
async function send(...inputs: string[]): Promise<string> {
  let r = ""
  for (const m of inputs) r = await shopWaRouter(FROM, m, null)
  return r
}
/** Shop code -> product menu -> Airtime. */
const toRecipient = () => send("1234", "2")

beforeEach(() => {
  h.state.sessions.clear()
  h.state.vis = { networkPlans: false, payBills: false, cashbackAirtime: false }
  h.state.shop = {
    shopCodeId: "code-1", shopId: "shop-1", parentShopId: "parent-1", shopName: SHOP, status: "active", whatsappActivated: true,
  }
  h.state.markup = 2
  h.state.quote = null
  h.state.quoteCalls = []
  h.state.updates = []
  for (const f of Object.values(h)) if (typeof f === "function" && "mockClear" in f) (f as any).mockClear()
})

/** Today's walk, asserted byte for byte. */
async function legacyWalk() {
  expect(await toRecipient()).toBe(RECIPIENT_PROMPT)
  expect(await send(RECIPIENT)).toBe(AMOUNT_PROMPT)
  expect(await send("20")).toBe(MOMO_PROMPT)
  expect(await send(PAY)).toBe(LEGACY_CONFIRM)
  expect(await send("1")).toBe(SENT)
  expect(h.createShopAirtimeOrder).toHaveBeenCalledTimes(1)
  expect(h.createShopAirtimeOrder.mock.calls[0][0]).toStrictEqual(LEGACY_ORDER)
  expect(h.chargeMobileMoney).toHaveBeenCalledTimes(1)
  expect(h.chargeMobileMoney.mock.calls[0][0]).toStrictEqual(LEGACY_CHARGE)
  expect(session()).toEqual({ step: "AI_CONVERSATION" })
}

describe("WhatsApp shop airtime: legacy (pinned before the cashback change)", () => {
  it("screens, order input and charge are today's", async () => {
    await legacyWalk()
  })

  it("invalid amount and junk at confirm repaint today's screens", async () => {
    await toRecipient()
    await send(RECIPIENT)
    expect(await send("abc")).toBe("Enter a valid amount.\n" + AMOUNT_PROMPT)
    await send("20", PAY)
    expect(await send("9")).toBe(LEGACY_CONFIRM)
  })

  it("a shop closed since the code step is refused before any order", async () => {
    await toRecipient()
    await send(RECIPIENT, "20", PAY)
    h.state.shop = { ...h.state.shop, status: "suspended" }
    expect(await send("1")).toBe(CLOSED)
    expect(h.createShopAirtimeOrder).not.toHaveBeenCalled()
    expect(h.chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("the Uzo switch and an Uzo-usable quote never change the WhatsApp shop bot", async () => {
    h.state.quote = (face: number) => ({ ...QUOTE, faceAmount: face })
    await legacyWalk()
    expect(h.state.quoteCalls).toEqual([])
  })
})

// ── Cashback ──────────────────────────────────────────────────────────────────
const QUOTE = {
  applied: true, faceAmount: 10, rate: 10, share: 50, commission: 1, customerCashback: 0.4, shopShare: 0.25,
  payAmount: 9.79, datagodKeeps: 0.35, provider: "hubtel", base: 9.6, paymentFee: 0.19, feeRate: 1.95,
}
