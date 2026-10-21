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
const onFor = (over: any = {}) => (face: number) => ({ ...QUOTE, faceAmount: face, ...over })
const cashbackOn = (over: any = {}) => {
  h.state.vis = { networkPlans: false, payBills: false, cashbackAirtime: true }
  h.state.quote = onFor(over)
}

const CB_AMOUNT_PROMPT = "MTN Airtime\nEnter airtime amount\n(GHS 1 - 500):\n\n0. Back"
const CB_CONFIRM = `${SHOP}\nMTN to 0241234567\nPay GHS 9.79 (was GHS 10.00)\nGet GHS 10.00 airtime\nfrom ${PAY}\n\n1. Pay now\n2. Cancel`
const PRICE_CHANGED = "Price changed. Please try again."

describe("WhatsApp shop airtime: cashback applied (WhatsApp switch on + usable quote)", () => {
  it("asks for the airtime amount; every quote is rail paystack with the storefront split (shop: true)", async () => {
    cashbackOn()
    await toRecipient()
    expect(await send(RECIPIENT)).toBe(CB_AMOUNT_PROMPT)
    expect(h.state.quoteCalls[0]).toEqual(["MTN", 1, { rail: "paystack", shop: true }])
    expect(await send("abc")).toBe("Enter a valid amount.\n" + CB_AMOUNT_PROMPT)
  })

  it("confirm shows Pay x (was y); the order carries the shop share and the typed number is charged payAmount", async () => {
    cashbackOn()
    await toRecipient()
    await send(RECIPIENT)
    expect(await send("10")).toBe(MOMO_PROMPT)
    expect(h.state.quoteCalls.at(-1)).toEqual(["MTN", 10, { rail: "paystack", shop: true }])
    expect(await send(PAY)).toBe(CB_CONFIRM)
    expect(await send("9")).toBe(CB_CONFIRM) // junk repaints the cashback screen
    expect(await send("1")).toBe(SENT)
    expect(h.createShopAirtimeOrder).toHaveBeenCalledTimes(1)
    expect(h.createShopAirtimeOrder.mock.calls[0][0]).toStrictEqual({
      ...LEGACY_ORDER,
      airtimeAmount: 10,
      feeAmount: 0, // the Paystack fee lives in payment_fee_amount only
      totalPaid: 9.79,
      merchantCommission: 0.25, // = the quote's shop share (no markup)
      cashbackColumns: {
        airtime_amount: 10,
        fee_amount: 0,
        total_paid: 9.79,
        payment_fee_amount: 0.19,
        cashback_amount: 0.4,
        shop_share_amount: 0.25,
        cashback_rate: 10,
        cashback_share: 50,
        cashback_provider: "hubtel",
        expected_commission: 1,
        merchant_commission: 0.25,
      },
    })
    expect(h.chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(h.chargeMobileMoney.mock.calls[0][0]).toStrictEqual({ ...LEGACY_CHARGE, amount: 9.79 })
  })

  it("more than 2 decimals is refused on the cashback branch", async () => {
    cashbackOn()
    await toRecipient()
    await send(RECIPIENT)
    expect(await send("10.555")).toBe("Enter a valid amount.\n" + CB_AMOUNT_PROMPT)
    expect(session().step).toBe("AIRTIME_ENTER_AMOUNT")
    expect(await send("10.55")).toBe(MOMO_PROMPT)
    expect(session()).toMatchObject({ airtimeAmount: 10.55, airtimeToDeliver: 10.55, airtimeFee: 0, airtimeCashbackPay: 9.79 })
  })

  it("re-quote mismatch at confirm: 'Price changed. Please try again.', no order, no charge", async () => {
    cashbackOn()
    await toRecipient()
    await send(RECIPIENT, "10", PAY)
    h.state.quote = onFor({ payAmount: 9.9 })
    expect(await send("1")).toBe(PRICE_CHANGED)
    expect(h.createShopAirtimeOrder).not.toHaveBeenCalled()
    expect(h.chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("cashback switched off since the screen: same refusal", async () => {
    cashbackOn()
    await toRecipient()
    await send(RECIPIENT, "10", PAY)
    h.state.vis = { networkPlans: false, payBills: false, cashbackAirtime: false }
    expect(await send("1")).toBe(PRICE_CHANGED)
    expect(h.createShopAirtimeOrder).not.toHaveBeenCalled()
  })

  it("AI-staged airtime (legacy price, no cashback price) while cashback applies: legacy order + charge, not refused", async () => {
    // Ruling 2026-10-21: confirm honours the pricing mode the session was staged with. lib/ai-tools.ts (unchanged)
    // stages today's pricing, so the customer is charged exactly the legacy price they were shown.
    cashbackOn()
    h.state.sessions.set(FROM, {
      step: "AIRTIME_CONFIRM", shopCodeId: "code-1", shopId: "shop-1", shopName: SHOP,
      airtimeNetwork: "MTN", airtimeRecipient: RECIPIENT, airtimeAmount: 20, airtimeFee: 1.31, airtimeToDeliver: 18.69,
      paymentPhone: PAY, paystackProvider: "vod",
    })
    expect(await send("1")).toBe(SENT)
    expect(h.createShopAirtimeOrder.mock.calls[0][0]).toStrictEqual(LEGACY_ORDER)
    expect(h.chargeMobileMoney.mock.calls[0][0]).toStrictEqual(LEGACY_CHARGE)
  })

  it("switch flipped ON after a legacy screen: the legacy price shown is charged, not refused", async () => {
    await toRecipient()
    await send(RECIPIENT, "20")
    expect(await send(PAY)).toBe(LEGACY_CONFIRM)
    cashbackOn()
    expect(await send("1")).toBe(SENT)
    expect(h.createShopAirtimeOrder.mock.calls[0][0]).toStrictEqual(LEGACY_ORDER)
    expect(h.chargeMobileMoney.mock.calls[0][0]).toStrictEqual(LEGACY_CHARGE)
  })

  it("a cashback-priced session without a shopId is refused with 409 (never sold at the legacy price)", async () => {
    cashbackOn()
    await toRecipient()
    await send(RECIPIENT, "10", PAY)
    const s = { ...session() }
    expect(s.airtimeCashbackPay).toBeDefined()
    delete s.shopId
    h.state.sessions.set(FROM, s)
    expect(await send("1")).toBe(PRICE_CHANGED)
    expect(h.createShopAirtimeOrder).not.toHaveBeenCalled()
    expect(h.chargeMobileMoney).not.toHaveBeenCalled()
    expect(session()).toEqual({ step: "AI_CONVERSATION" })
  })

  it("the shop is re-checked before the order: closed => refused, no quote at confirm, no order", async () => {
    cashbackOn()
    await toRecipient()
    await send(RECIPIENT, "10", PAY)
    const quotesBefore = h.state.quoteCalls.length
    h.state.shop = { ...h.state.shop, whatsappActivated: false }
    expect(await send("1")).toBe(CLOSED)
    expect(h.state.quoteCalls.length).toBe(quotesBefore)
    expect(h.createShopAirtimeOrder).not.toHaveBeenCalled()
    expect(h.chargeMobileMoney).not.toHaveBeenCalled()
  })
})

describe("WhatsApp shop airtime: cashback NOT applied stays byte-identical", () => {
  it("switch off with a usable quote: today's walk, the quote is never asked", async () => {
    h.state.quote = onFor()
    await legacyWalk()
    expect(h.state.quoteCalls).toEqual([])
  })

  it("switch on, no quote: today's walk", async () => {
    h.state.vis = { networkPlans: false, payBills: false, cashbackAirtime: true }
    await legacyWalk()
  })

  for (const [label, over] of [
    ["not applied", { applied: false }],
    ["NaN payAmount", { payAmount: NaN }],
    ["negative shop share", { shopShare: -0.1 }],
    ["face mismatch", { faceAmount: 11 }],
  ] as const) {
    it(`switch on, unusable quote (${label}): today's order and charge`, async () => {
      cashbackOn()
      h.state.quote = (face: number) => ({ ...QUOTE, faceAmount: face, ...over })
      await toRecipient()
      await send(RECIPIENT)
      expect(await send("20")).toBe(MOMO_PROMPT)
      expect(await send(PAY)).toBe(LEGACY_CONFIRM)
      expect(await send("1")).toBe(SENT)
      expect(h.createShopAirtimeOrder.mock.calls[0][0]).toStrictEqual(LEGACY_ORDER)
      expect(h.chargeMobileMoney.mock.calls[0][0]).toStrictEqual(LEGACY_CHARGE)
    })
  }
})
