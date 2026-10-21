// Router-level tests: commission-cashback "Network Plans" + "Pay Bills" on the WhatsApp SHOP bot (shopWaRouter).
// - Product menu: the items come at the END only when whatsappBotItemsVisible says so; switches off => the menu text,
//   the digits and the natural-reply mapping are byte-identical to today.
// - Both flows run end to end through the shop router with the shared flows (WHATSAPP_PROFILE), surface
//   "whatsapp_shop", shopId = the shop the session resolved (never its parent) and the sender in local 0X form as the
//   buyer; the MoMo number is always typed (the shop bot's own payment-phone wording), never the sender's.
// - The shop is re-checked (isShopStillOpen) right before the order: a closed shop refuses with the shop-closed text.
// - NEEDS_VERIFY and Paystack send_otp are finished in chat; "0" cancels; free text is never mapped to digits there.
// - The data whitelist hides Network Plans exactly like Browse Services (Pay Bills is not affected).
// Only the engine edge (catalog, orders, charge, verify, quote, pointer store), the shop lookups and the stores are faked.
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    sessions: new Map<string, any>(),
    vis: { networkPlans: false, payBills: false, cashbackAirtime: false },
    pointer: null as any,
    submit: { ok: true, retry: false } as { ok: boolean; retry: boolean },
    order: { status: "pending", payment_status: "unpaid" } as Record<string, string>,
    whitelist: false,
    shop: {
      shopCodeId: "code-1", shopId: "shop-1", parentShopId: "parent-1", shopName: "Kofi Data",
      status: "active", whatsappActivated: true,
    } as Record<string, unknown>,
  }
  /** Supabase fake: every chain method returns the chain; maybeSingle() answers by table. */
  const db = {
    from(table: string) {
      const chain: any = new Proxy({}, {
        get(_t, prop) {
          if (prop === "maybeSingle" || prop === "single") {
            return async () => {
              if (table.startsWith("hubtel_")) return { data: { ...state.order }, error: null }
              if (table === "ussd_shop_codes") return { data: { code: "1234" }, error: null }
              if (table === "admin_settings") return { data: { value: { enabled: state.whitelist } }, error: null }
              return { data: null, error: null }
            }
          }
          if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: null, error: null })
          return () => chain
        },
      })
      return chain
    },
    rpc: async () => ({ data: false, error: null }), // has_completed_purchase: no prior purchase
  }
  const plans = Array.from({ length: 3 }, (_, i) => ({
    value: `MTN_${i + 1}`, display: `Data ${i + 1}GB Bundle`, amount: 11 + i, category: "Data",
    token: `tok-${i + 1}`, payAmount: 10.5 + i, customerCashback: 0.6, paymentFee: 0.1,
  }))
  return {
    state, db,
    vis: vi.fn(async () => ({ ...state.vis })),
    resolveShopCode: vi.fn(async () => ({ ...state.shop })),
    catalog: vi.fn(async (..._a: unknown[]): Promise<any> => ({ ok: true, categories: [{ name: "Data", bundles: plans }] })),
    createBundle: vi.fn(async (..._a: unknown[]): Promise<any> => ({
      ok: true, order: { id: "np-order-1", reference: "R1", payAmount: 10.5, faceAmount: 11, customerCashback: 0.6, paymentFee: 0.1 },
    })),
    createBill: vi.fn(async (_d: unknown, _bc: unknown, i: any): Promise<any> => ({
      ok: true, order: { id: "pb-order-1", reference: "R2", payAmount: i.expectedPay, faceAmount: i.amount, customerCashback: 0.5, paymentFee: 0 },
    })),
    verifyBill: vi.fn(async (_d: unknown, _bc: unknown, i: any): Promise<any> => ({
      ok: true, customerName: "K***h M***h", amountDue: 80, suggestedAmount: 80, token: `tok-${i.biller}`,
    })),
    quote: vi.fn((i: any) => ({ payAmount: Math.round(i.faceAmount * 99) / 100 })),
    charge: vi.fn(async (_rt: unknown, i: any): Promise<any> => ({ ok: true, reference: "pay-ref", status: "pay_offline", promptedPhone: i.payPhone })),
    failBotCharge: vi.fn(async () => {}),
    sendPayerOtp: vi.fn(async () => ({ ok: true })),
    verifyPayerOtp: vi.fn(async (_p: string, code: string) => (code === "123456" ? { ok: true, retry: false } : { ok: false, retry: true })),
    peek: vi.fn(async (_phone: string, _channel?: string) => state.pointer),
    submitBotOtp: vi.fn(async () => ({ ...state.submit })),
    clear: vi.fn(async () => {}),
    chargeMobileMoney: vi.fn(),
    submitOtp: vi.fn(),
  }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.db }))
vi.mock("./shop-session", () => ({
  getSession: async (id: string) => h.state.sessions.get(id) ?? null,
  setSession: async (id: string, s: any) => { h.state.sessions.set(id, JSON.parse(JSON.stringify(s))) },
  deleteSession: async (id: string) => { h.state.sessions.delete(id) },
}))
// The main bot's stores are never touched by the shop bot (asserted below through the shop store only).
vi.mock("./session", () => ({
  getWaSession: async () => null, setWaSession: async () => { throw new Error("main WhatsApp session written") },
  deleteWaSession: async () => {}, extendWaSession: async () => {},
}))
vi.mock("@/lib/ussd/session", () => ({
  getSession: async () => null, setSession: async () => { throw new Error("USSD session written") },
  deleteSession: async () => {}, isRedisConfigured: () => true, getUssdRedis: () => null,
}))
vi.mock("./send", () => ({ sendWhatsAppText: vi.fn(async () => "wamid") }))
vi.mock("./log-message", () => ({ logMessage: vi.fn(async () => {}) }))
vi.mock("@/lib/whatsapp-bot/shop-prefs", () => ({ getShopPref: async () => null, setShopPref: async () => {}, clearShopPref: async () => {} }))
vi.mock("@/lib/shop-commerce/shop-code", () => ({
  resolveShopCode: h.resolveShopCode, fetchShopNetworks: async () => ["MTN"], getCanonicalShopName: async () => "Kofi Data",
}))
vi.mock("@/lib/shop-commerce/pricing", () => ({ fetchShopBundles: vi.fn(), verifyBundlePrice: vi.fn(), shopOwnerIsDealer: vi.fn() }))
vi.mock("@/lib/shop-commerce/orders", () => ({
  createShopBundleOrder: vi.fn(), createShopAirtimeOrder: vi.fn(), createShopRcOrder: vi.fn(), createShopCheckResultsRequest: vi.fn(),
}))
vi.mock("@/lib/paystack", () => ({ chargeMobileMoney: h.chargeMobileMoney, submitOtp: h.submitOtp }))
vi.mock("@/lib/results-checker-service", () => ({
  isExamBoardEnabled: vi.fn(), getAvailableCount: vi.fn(), getMaxQuantity: vi.fn(), calculateRCPrice: vi.fn(),
  getRCBulkHint: vi.fn(), calculateResultsCheckPrice: vi.fn(),
}))
vi.mock("@/lib/ussd/handlers/results-checker", () => ({ buildRcBoardOptions: vi.fn() }))
vi.mock("@/lib/ussd-service-visibility", () => ({
  getUssdServiceVisibility: async () => ({ data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true }),
}))
vi.mock("./cashback-visibility", () => ({ whatsappBotItemsVisible: h.vis }))
vi.mock("@/lib/bot-commission/catalog", () => ({ botCatalog: h.catalog }))
vi.mock("@/lib/bot-commission/orders", () => ({
  botCreateBundleOrder: h.createBundle, botCreateBillOrder: h.createBill, BOT_BILL_TOKEN_EXPIRED: "Please verify the account again",
}))
vi.mock("@/lib/bot-commission/momo", () => ({ botChargeMomo: h.charge, getBotMomoRuntime: () => ({ db: h.db, marker: "runtime" }) }))
vi.mock("@/lib/bot-commission/momo-fail", () => ({ failBotCharge: h.failBotCharge }))
vi.mock("@/lib/bot-commission/payer-verify", () => ({ sendPayerOtp: h.sendPayerOtp, verifyPayerOtp: h.verifyPayerOtp }))
vi.mock("@/lib/bot-commission/runtime", () => ({
  getBotBundlesRuntime: () => ({ deps: { findBotBundleOrder: async () => null }, db: h.db }),
  getBotBillsRuntime: () => ({
    deps: {
      getBillsConfig: async () => ({
        enabled: true,
        billers: { ghana_water: { enabled: true, min: 1, max: 5000 }, dstv: { enabled: true, min: 5, max: 2000 } },
      }),
      getCashbackConfig: async () => ({}),
      findBotBillOrderByHash: async () => null,
    },
    db: h.db,
  }),
}))
vi.mock("@/lib/bot-commission/verify", () => ({ botVerifyBill: h.verifyBill }))
vi.mock("@/lib/cashback/quote", () => ({ quoteBots: h.quote }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: async () => ({ enabled: false, map: {} }) }))
vi.mock("@/lib/bot-commission/otp-pointer", () => ({
  peekBotOtpPointer: h.peek, submitBotOtp: h.submitBotOtp, clearBotOtpPointer: h.clear,
}))

import { shopWaRouter } from "./shop-router"
import { shopNetworkMenu, shopPaymentPhonePrompt, shopInvalidPaymentPhoneMenu, shopProductMenu } from "./shop-menus"

const FROM = "233244123456"   // the WhatsApp sender (Meta's wa_id)
const ME = "0244123456"       // the same number, local form: the buyer
const PAY = "0201234567"      // the typed MoMo number
const SHOP = "Kofi Data"
const OFF = `${SHOP}\nWhat to buy?\n1. Data Bundle\n2. Airtime\n3. Results Checker\n4. Check My Results\n0. Exit`
const OFF_BLOCKED = `${SHOP}\nWhat to buy?\n1. Airtime\n2. Results Checker\n3. Check My Results\n0. Exit`
const ON = `${SHOP}\nWhat to buy?\n1. Data Bundle\n2. Airtime\n3. Results Checker\n4. Check My Results\n5. Network Plans\n6. Pay Bills\n0. Exit`
const ON_BLOCKED = `${SHOP}\nWhat to buy?\n1. Airtime\n2. Results Checker\n3. Check My Results\n4. Pay Bills\n0. Exit`
const NP_FIRST = `${SHOP}\nNetwork Plans\n1. MTN\n2. Telecel\n3. AT\n0. Back`
const VERIFY = `We sent a 6-digit code by SMS to ${PAY}.\nReply with the code to verify this MoMo number.\n\n0. Cancel`
const SENT = `MoMo prompt sent to ${PAY}. Approve it on your phone to complete.\n\nReceived an OTP instead? Reply here with the code.`
const OTP_PROMPT = "Pending payment.\nEnter the OTP sent\nto your number to\ncomplete payment:\n\n0. Cancel"
const APPROVE = "Check your phone for\na MoMo authorization\nprompt and approve\nto complete payment."
const CLOSED = "This shop is currently unavailable. Please contact the seller."
const NP_CONFIRM = `${SHOP}\nPay GHS 10.50 (was GHS 11.00)\nYou get MTN Data 1GB Bundle\nTo: ${ME}\nMoMo: ${PAY}\n1. Confirm\n2. Cancel`
const BC = { botSurface: "whatsapp_shop", shopId: "shop-1", rail: "paystack", buyerPhone: ME }

const session = () => h.state.sessions.get(FROM)
async function send(...inputs: string[]): Promise<string> {
  let r = ""
  for (const m of inputs) r = await shopWaRouter(FROM, m, null)
  return r
}
const on = () => { h.state.vis = { networkPlans: true, payBills: true, cashbackAirtime: false } }
/** Enter the shop by its code (no session yet): lands on the product menu. */
const enter = () => send("1234")

beforeEach(() => {
  h.state.sessions.clear()
  h.state.vis = { networkPlans: false, payBills: false, cashbackAirtime: false }
  h.state.pointer = null
  h.state.submit = { ok: true, retry: false }
  h.state.order = { status: "pending", payment_status: "unpaid" }
  h.state.whitelist = false
  h.state.shop = {
    shopCodeId: "code-1", shopId: "shop-1", parentShopId: "parent-1", shopName: SHOP, status: "active", whatsappActivated: true,
  }
  for (const f of Object.values(h)) if (typeof f === "function" && "mockClear" in f) (f as any).mockClear()
})

describe("shop product menu", () => {
  it("switches off: the menu text, the digits and the natural mapping are byte-identical to today", async () => {
    expect(shopProductMenu(SHOP)).toBe(OFF)
    expect(shopProductMenu(SHOP, false)).toBe(OFF_BLOCKED)
    expect(await enter()).toBe(OFF)
    for (const d of ["5", "6", "9"]) {
      expect(await send(d)).toBe(OFF)
      expect(session()?.step).toBe("SELECT_PRODUCT")
    }
    expect(await send("1")).toBe(shopNetworkMenu(SHOP, ["MTN"]))
    // Off: "pay bills" is not a menu word; the reply escapes to the AI exactly as today.
    h.state.sessions.clear()
    await enter()
    expect(await send("pay bills")).toBe("")
    expect(session()).toEqual({ step: "AI_CONVERSATION" })
    expect(h.catalog).not.toHaveBeenCalled()
    expect(h.vis).toHaveBeenCalled() // the WhatsApp switches decide
  })

  it("switches on: the items come at the END; the legacy digits never move", async () => {
    on()
    expect(await enter()).toBe(ON)
    expect(await send("9")).toBe(ON)
    expect(await send("1")).toBe(shopNetworkMenu(SHOP, ["MTN"]))
    expect(await send("0")).toBe(ON) // back to the product menu: still the full menu
    expect(await send("5")).toBe(NP_FIRST)
    expect(await send("0")).toBe(ON) // leaving the flow lands on the shop's product menu
    expect(session()?.step).toBe("SELECT_PRODUCT")
    expect(session()?.shopId).toBe("shop-1")
  })

  it("natural replies pick the items only when they are visible", async () => {
    on()
    await enter()
    expect(await send("Pay Bills")).toBe(`${SHOP}\nPay Bills\n1. Ghana Water\n2. DStv\n0. Back`)
    h.state.sessions.clear()
    await enter()
    expect(await send("network plans")).toBe(NP_FIRST)
    // Only Pay Bills on: "network plans" is not a menu word.
    h.state.vis = { networkPlans: false, payBills: true, cashbackAirtime: false }
    h.state.sessions.clear()
    expect(await enter()).toBe(OFF.replace("\n0. Exit", "\n5. Pay Bills\n0. Exit"))
    expect(await send("network plans")).toBe("")
    expect(session()).toEqual({ step: "AI_CONVERSATION" })
  })
})

describe("data whitelist", () => {
  it("hides Network Plans exactly like Browse Services; Pay Bills stays", async () => {
    on()
    h.state.whitelist = true
    expect(await enter()).toBe(ON_BLOCKED)
    expect(await send("5")).toBe(ON_BLOCKED) // no item 5 when blocked
    expect(await send("network plans")).toBe("") // not a menu word when hidden
    h.state.sessions.clear()
    await enter()
    expect(await send("4")).toBe(`${SHOP}\nPay Bills\n1. Ghana Water\n2. DStv\n0. Back`)
    expect(h.catalog).not.toHaveBeenCalled()
  })

  it("re-checked live when Network Plans is picked (whitelist switched on after the code was entered)", async () => {
    on()
    expect(await enter()).toBe(ON)
    h.state.whitelist = true
    const r = await send("5")
    expect(r).toContain("Data bundles not available.")
    expect(session()?.step).toBe("SELECT_PRODUCT")
    expect(h.catalog).not.toHaveBeenCalled()
  })

  it("off with the whitelist on: today's blocked menu, byte for byte", async () => {
    h.state.whitelist = true
    expect(await enter()).toBe(OFF_BLOCKED)
    expect(await send("4")).toBe(OFF_BLOCKED)
  })
})

describe("Network Plans through the shop router", () => {
  it("end to end: the resolved shop (never its parent), the sender is the buyer, the TYPED number is charged", async () => {
    on()
    await enter()
    expect(await send("5")).toBe(NP_FIRST)
    expect(await send("1")).toBe("MTN\nSelect type:\n1. Data\n0. Back")
    expect(await send("1")).toBe("MTN Data\n1. 10.50 Data 1GB Bundle\n2. 11.50 Data 2GB Bundle\n3. 12.50 Data 3GB Bundle\n0. Back")
    expect(await send("1")).toBe(`${SHOP}\nRecipient:\n1. My number\n2. Other number\n0. Back`)
    expect(await send("my number")).toBe(shopPaymentPhonePrompt()) // the shop bot's own wording
    expect(session()).toMatchObject({ step: "NP_PAY_PHONE", npRecipient: ME, shopId: "shop-1" })
    expect(await send(PAY)).toBe(NP_CONFIRM)
    expect(h.createBundle).not.toHaveBeenCalled()
    expect(await send("yes")).toBe(SENT)
    expect(h.catalog.mock.calls[0][1]).toEqual(BC)
    expect(h.createBundle).toHaveBeenCalledTimes(1)
    expect(h.createBundle.mock.calls[0][1]).toEqual(BC)
    expect(h.createBundle.mock.calls[0][2]).toMatchObject({ token: "tok-1", recipient: ME, expectedPay: 10.5 })
    expect(h.charge).toHaveBeenCalledTimes(1)
    expect(h.charge.mock.calls[0][1]).toEqual({
      orderType: "cs_bundle", orderId: "np-order-1", botSurface: "whatsapp_shop", shopId: "shop-1", dialingPhone: ME, payPhone: PAY,
    })
    expect(h.chargeMobileMoney).not.toHaveBeenCalled() // never the shop bot's legacy charge path
    // The flow is closed: back on the shop's product step, no flow fields, the shop kept.
    const s = session()
    expect(s.step).toBe("SELECT_PRODUCT")
    expect(s.shopId).toBe("shop-1")
    expect(Object.keys(s).filter(k => k.startsWith("np") || k.startsWith("pb"))).toEqual([])
  })

  it("the MoMo number step never maps free text and never charges the sender; 0 cancels (shop wording)", async () => {
    on()
    await enter()
    await send("5", "1", "1", "1", "1")
    for (const text of ["yes", "my number", "1", "me"]) {
      expect(await send(text)).toBe(shopInvalidPaymentPhoneMenu())
    }
    expect(session()?.step).toBe("NP_PAY_PHONE")
    expect(await send("0")).toBe("Order cancelled.")
    expect(session()?.step).toBe("SELECT_PRODUCT")
    expect(h.createBundle).not.toHaveBeenCalled()
    expect(h.charge).not.toHaveBeenCalled()
  })

  it("cancel at confirm (\"no\"), then \"1\" creates nothing", async () => {
    on()
    await enter()
    await send("5", "1", "1", "1", "1", PAY)
    expect(await send("no")).toBe("Order cancelled.")
    expect(await send("1")).toBe(shopNetworkMenu(SHOP, ["MTN"])) // just the product menu's "1"
    expect(h.createBundle).not.toHaveBeenCalled()
    expect(h.charge).not.toHaveBeenCalled()
  })

  it("a shop closed since the code was entered refuses the order (shop-closed text, nothing created or charged)", async () => {
    on()
    await enter()
    await send("5", "1", "1", "1", "1", PAY)
    h.state.shop = { ...h.state.shop, status: "suspended" }
    expect(await send("1")).toBe(CLOSED)
    expect(h.createBundle).not.toHaveBeenCalled()
    expect(h.charge).not.toHaveBeenCalled()
    expect(session()?.step).toBe("SELECT_PRODUCT")
    expect(session()?.npPlan).toBeUndefined()
  })

  it("WhatsApp deactivated for the shop: refused the same way", async () => {
    on()
    await enter()
    await send("5", "1", "1", "1", "1", PAY)
    h.state.shop = { ...h.state.shop, whatsappActivated: false }
    expect(await send("1")).toBe(CLOSED)
    expect(h.createBundle).not.toHaveBeenCalled()
  })

  it("free text inside the flow never escapes to the AI (the screen repaints)", async () => {
    on()
    await enter()
    await send("5")
    expect(await send("what is this?")).toBe(NP_FIRST)
    expect(session()?.step).toBe("NP_NETWORK")
  })
})

describe("Pay Bills through the shop router", () => {
  it("Ghana Water end to end with an email: validated, carried to the lookup, typed number charged, the shop's share", async () => {
    on()
    await enter()
    expect(await send("6")).toBe(`${SHOP}\nPay Bills\n1. Ghana Water\n2. DStv\n0. Back`)
    expect(await send("1")).toContain("Enter meter number:")
    expect(await send("GW123456")).toContain("Enter the phone number linked to the meter:")
    expect(await send("0551234567")).toBe("Enter your email address (Ghana Water requires it):\n0. Back")
    expect(await send("kofi@mail")).toBe("Enter a valid email.\nEnter your email address (Ghana Water requires it):\n0. Back")
    expect(h.verifyBill).not.toHaveBeenCalled()
    expect(await send("kofi@mail.com")).toContain("Name: K***h M***h")
    expect(h.verifyBill.mock.calls[0][1]).toEqual(BC)
    expect(h.verifyBill.mock.calls[0][2]).toEqual({ biller: "ghana_water", account: "GW123456", phone: "0551234567", email: "kofi@mail.com" })
    expect(await send("80")).toBe(shopPaymentPhonePrompt())
    expect(await send(PAY)).toContain(`Pay GHS 79.20 (was GHS 80.00)`)
    expect(await send("1")).toBe(SENT)
    expect(h.createBill.mock.calls[0][1]).toEqual(BC)
    expect(h.createBill.mock.calls[0][2]).toEqual({ token: "tok-ghana_water", amount: 80, expectedPay: 79.2 })
    expect(h.charge.mock.calls[0][1]).toEqual({
      orderType: "cs_bill", orderId: "pb-order-1", botSurface: "whatsapp_shop", shopId: "shop-1", dialingPhone: ME, payPhone: PAY,
    })
    expect(session()?.step).toBe("SELECT_PRODUCT")
  })

  it("a closed shop refuses the bill order too", async () => {
    on()
    await enter()
    await send("6", "2", "7012345678", "50", PAY)
    h.state.shop = { ...h.state.shop, status: "blocked" }
    expect(await send("1")).toBe(CLOSED)
    expect(h.createBill).not.toHaveBeenCalled()
    expect(h.charge).not.toHaveBeenCalled()
  })

  it("cancel at confirm, then \"1\" creates nothing", async () => {
    on()
    await enter()
    await send("6", "2", "7012345678", "50", PAY)
    expect(await send("cancel")).toBe("Order cancelled.")
    await send("1")
    expect(h.createBill).not.toHaveBeenCalled()
    expect(h.charge).not.toHaveBeenCalled()
  })
})

describe("NEEDS_VERIFY in chat", () => {
  const NEEDS = { ok: false, code: "NEEDS_VERIFY", message: "Please verify this MoMo number first." }

  it("the code goes to the payer check; free text is never mapped; the right code charges the SAME order", async () => {
    on()
    await enter()
    h.charge.mockResolvedValueOnce(NEEDS)
    expect(await send("5", "1", "1", "1", "1", PAY, "1")).toBe(VERIFY)
    expect(h.sendPayerOtp).toHaveBeenCalledWith(PAY, ME)
    expect(session()).toMatchObject({ step: "NP_PAY_VERIFY", npOrderId: "np-order-1", npPayPhone: PAY, shopId: "shop-1" })
    for (const text of ["yes", "cancel", "my number", "1"]) {
      expect(await send(text)).toBe(`Please reply with the 6-digit code.\n${VERIFY}`)
    }
    expect(h.verifyPayerOtp).not.toHaveBeenCalled()
    expect(await send("000000")).toBe(`Wrong code. Try again.\n${VERIFY}`)
    expect(await send("123456")).toBe(SENT)
    expect(h.charge).toHaveBeenCalledTimes(2)
    expect(h.charge.mock.calls[1][1]).toEqual(h.charge.mock.calls[0][1])
    expect(h.createBundle).toHaveBeenCalledTimes(1)
    expect(session()?.step).toBe("SELECT_PRODUCT")
  })

  it("0 cancels the order (Pay Bills); a later \"1\" creates nothing", async () => {
    on()
    await enter()
    h.charge.mockResolvedValueOnce(NEEDS)
    expect(await send("6", "2", "7012345678", "50", PAY, "1")).toBe(VERIFY)
    expect(await send("0")).toBe("Order cancelled.")
    expect(h.failBotCharge).toHaveBeenCalled()
    await send("1")
    expect(h.charge).toHaveBeenCalledTimes(1)
    expect(h.createBill).toHaveBeenCalledTimes(1)
  })

  it("the shop closed while the code was pending: the order is failed, never charged", async () => {
    on()
    await enter()
    h.charge.mockResolvedValueOnce(NEEDS)
    await send("5", "1", "1", "1", "1", PAY, "1")
    h.state.shop = { ...h.state.shop, status: "suspended" }
    expect(await send("123456")).toBe(CLOSED)
    expect(h.verifyPayerOtp).not.toHaveBeenCalled()
    expect(h.charge).toHaveBeenCalledTimes(1)
    expect(h.failBotCharge).toHaveBeenCalled()
    expect(session()?.step).toBe("SELECT_PRODUCT")
  })
})

describe("Paystack send_otp in chat", () => {
  /** The charge stores the sender's wa-bot-otp pointer (as botChargeMomo does) and answers send_otp. */
  function sendOtpCharge() {
    h.charge.mockImplementationOnce(async (_rt: unknown, i: any) => {
      h.state.pointer = {
        reference: "pay-ref", orderType: i.orderType, orderId: i.orderId, createdAt: new Date().toISOString(), phone: ME, channel: "whatsapp",
      }
      return { ok: true, reference: "pay-ref", status: "send_otp", promptedPhone: i.payPhone }
    })
  }

  it("the next reply goes to submitBotOtp: wrong code retries, the right code ends with the approve text", async () => {
    on()
    await enter()
    sendOtpCharge()
    expect(await send("5", "1", "1", "1", "1", PAY, "1")).toBe(SENT)
    expect(h.peek).toHaveBeenCalledWith(ME, "whatsapp")
    expect(session()).toMatchObject({ step: "SUBMIT_OTP", botOtp: true })
    h.state.submit = { ok: false, retry: true }
    expect(await send("1111")).toBe(`Wrong code. Try again.\n${OTP_PROMPT}`)
    expect(session()).toMatchObject({ step: "SUBMIT_OTP", botOtp: true })
    h.state.submit = { ok: true, retry: false }
    expect(await send("2222")).toBe(APPROVE)
    expect(h.submitBotOtp).toHaveBeenCalledTimes(2)
    expect((h.submitBotOtp.mock.calls as unknown as unknown[][])[1][2]).toBe("2222")
    expect(h.submitOtp).not.toHaveBeenCalled() // never the legacy shop OTP path
    expect(session()).toEqual({ step: "AI_CONVERSATION" })
  })

  it("0 cancels: guarded fail of payment + order, the WhatsApp pointer is cleared; \"1\" afterwards does nothing", async () => {
    on()
    await enter()
    sendOtpCharge()
    await send("6", "2", "7012345678", "50", PAY, "1")
    expect(await send("0")).toBe("Order cancelled.")
    expect(h.failBotCharge).toHaveBeenCalledWith(h.db, "cs_bill", "pb-order-1", "pay-ref", expect.any(String))
    expect(h.clear).toHaveBeenCalledWith(ME, "whatsapp")
    expect(await send("1")).toBe("")
    expect(h.submitBotOtp).not.toHaveBeenCalled()
    expect(h.createBill).toHaveBeenCalledTimes(1)
    expect(h.charge).toHaveBeenCalledTimes(1)
  })

  it("an older pointer (not from this charge) never takes over the chat", async () => {
    on()
    await enter()
    h.state.pointer = {
      reference: "old", orderType: "cs_bundle", orderId: "old-order", createdAt: new Date(Date.now() - 60_000).toISOString(), phone: ME, channel: "whatsapp",
    }
    expect(await send("5", "1", "1", "1", "1", PAY, "1")).toBe(SENT)
    expect(session()?.step).toBe("SELECT_PRODUCT")
  })
})
