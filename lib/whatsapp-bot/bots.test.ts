// Router-level tests: commission-cashback "Network Plans" + "Pay Bills" on the MAIN WhatsApp bot (waRouter).
// - Main menu: the items appear at the END only when whatsappBotItemsVisible says so; switches off => the menu text and
//   the digit dispatch are byte-identical to today (and mainMenu() with no args, the AI tool's, never changes).
// - Both flows run end to end through the router with the shared flows (WHATSAPP_PROFILE), surface "whatsapp",
//   shopId null and the sender in local 0X form as the buyer; the MoMo number is always typed (never the sender's).
// - NEEDS_VERIFY: the SMS code is entered in chat (free text is never mapped to a digit there).
// - Paystack send_otp: the wa-bot-otp pointer of the sender routes the next reply to submitBotOtp (retry / cancel).
// Only the engine edge (catalog, orders, charge, verify, quote, pointer store) and the stores are faked.
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    sessions: new Map<string, any>(),
    vis: { networkPlans: false, payBills: false, cashbackAirtime: false },
    pointer: null as any,
    submit: { ok: true, retry: false } as { ok: boolean; retry: boolean },
    order: { status: "pending", payment_status: "unpaid" } as Record<string, string>,
  }
  /** Supabase fake: every chain method returns the chain; maybeSingle() answers the bot order read-back. */
  const db = {
    from(table: string) {
      const chain: any = new Proxy({}, {
        get(_t, prop) {
          if (prop === "maybeSingle") {
            return async () => ({ data: table.startsWith("hubtel_") ? { ...state.order } : null, error: null })
          }
          if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: null, error: null })
          return () => chain
        },
      })
      return chain
    },
    rpc: async () => ({ data: false, error: null }),
  }
  const plans = Array.from({ length: 3 }, (_, i) => ({
    value: `MTN_${i + 1}`, display: `Data ${i + 1}GB Bundle`, amount: 11 + i, category: "Data",
    token: `tok-${i + 1}`, payAmount: 10.5 + i, customerCashback: 0.6, paymentFee: 0.1,
  }))
  return {
    state, db,
    vis: vi.fn(async () => ({ ...state.vis })),
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
    // Channel-aware like the real store: a pointer is only found in its own key space.
    peek: vi.fn(async (_phone: string, channel?: string) =>
      state.pointer && (state.pointer.channel ?? "ussd") === (channel ?? "ussd") ? state.pointer : null),
    submitBotOtp: vi.fn(async () => ({ ...state.submit })),
    clear: vi.fn(async () => {}),
    legacySubmitOtp: vi.fn(async (..._a: unknown[]) => ({ message: "LEGACY-OTP-REPLY", ussdServiceOp: 2 as const })),
  }
})

// Only the legacy data OTP handler is spied (SUBMIT_OTP without botOtp); every other bundles handler is real.
vi.mock("@/lib/ussd/handlers/bundles", async (orig) => ({
  ...(await orig<typeof import("@/lib/ussd/handlers/bundles")>()),
  handleSubmitOtp: h.legacySubmitOtp,
}))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.db }))
vi.mock("./session", () => ({
  getWaSession: async (id: string) => h.state.sessions.get(id) ?? null,
  setWaSession: async (id: string, s: any) => { h.state.sessions.set(id, JSON.parse(JSON.stringify(s))) },
  deleteWaSession: async (id: string) => { h.state.sessions.delete(id) },
  extendWaSession: async () => {},
}))
// The USSD session store writes the SAME Redis key as the WhatsApp one (lib/whatsapp-bot/session.ts).
vi.mock("@/lib/ussd/session", () => ({
  getSession: async (id: string) => h.state.sessions.get(id) ?? null,
  setSession: async (id: string, s: any) => { h.state.sessions.set(id, JSON.parse(JSON.stringify(s))) },
  deleteSession: async (id: string) => { h.state.sessions.delete(id) },
  isRedisConfigured: () => true,
  getUssdRedis: () => null,
}))
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

import { waRouter } from "./router"
import { waMainBotOtpFallback } from "./bot-flows"
import { mainMenu, networkMenu } from "@/lib/ussd/menus"

const FROM = "233244123456"   // the WhatsApp sender (Meta's wa_id)
const ME = "0244123456"       // the same number, local form: the buyer
const PAY = "0201234567"      // the typed MoMo number
const LEGACY = "Welcome to Datagod\n1. Browse Services\n2. AFA Registration\n3. Buy Airtime\n4. Results Checker\n0. Exit"
const WITH_BOTS = "Welcome to Datagod\n1. Browse Services\n2. AFA Registration\n3. Buy Airtime\n4. Results Checker\n5. Network Plans\n6. Pay Bills\n0. Exit"
const PROMPT = "Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Back"
const VERIFY = `We sent a 6-digit code by SMS to ${PAY}.\nReply with the code to verify this MoMo number.\n\n0. Cancel`
const SENT = `MoMo prompt sent to ${PAY}. Approve it on your phone to complete.\n\nIf you receive an OTP code, reply here with it.`
const OTP_PROMPT = "Pending payment.\nEnter the OTP sent\nto your number to\ncomplete payment:\n\n0. Cancel"
const APPROVE = "Check your phone for\na MoMo authorization\nprompt and approve\nto complete payment."
const NP_CONFIRM = `Pay GHS 10.50 (was GHS 11.00)\nYou get MTN Data 1GB Bundle\nTo: ${ME}\nMoMo: ${PAY}\n1. Confirm\n2. Cancel`
const BC = { botSurface: "whatsapp", shopId: null, rail: "paystack", buyerPhone: ME }

const session = () => h.state.sessions.get(FROM)
async function send(...inputs: string[]): Promise<string> {
  let r = ""
  for (const m of inputs) r = await waRouter(FROM, m)
  return r
}
const atMain = () => h.state.sessions.set(FROM, { step: "MAIN", dialingPhone: ME })
const on = () => { h.state.vis = { networkPlans: true, payBills: true, cashbackAirtime: false } }

beforeEach(() => {
  h.state.sessions.clear()
  h.state.vis = { networkPlans: false, payBills: false, cashbackAirtime: false }
  h.state.pointer = null
  h.state.submit = { ok: true, retry: false }
  h.state.order = { status: "pending", payment_status: "unpaid" }
  for (const f of Object.values(h)) if (typeof f === "function" && "mockClear" in f) (f as any).mockClear()
  atMain()
})

describe("main menu on WhatsApp", () => {
  it("switches off: the menu text and digits are byte-identical to today; nothing of the engine is touched", async () => {
    expect(mainMenu()).toBe(LEGACY) // the AI tool's no-arg menu never changes
    expect(await send("9")).toBe(LEGACY)
    for (const d of ["5", "6"]) {
      atMain()
      expect(await send(d)).toBe(LEGACY)
      expect(session()).toEqual({ step: "MAIN", dialingPhone: ME })
    }
    atMain()
    expect(await send("1")).toBe(networkMenu())
    expect(session()?.step).toBe("SELECT_NETWORK")
    // An unknown step resets to the menu: still the no-arg menu.
    h.state.sessions.set(FROM, { step: "BOGUS", dialingPhone: ME })
    expect(await send("x")).toBe(LEGACY)
    expect(h.catalog).not.toHaveBeenCalled()
    expect(h.vis).toHaveBeenCalled() // the WhatsApp switches are what decide (never the Uzo gate)
  })

  it("switches on: the items come at the END; the legacy digits never move", async () => {
    on()
    expect(await send("9")).toBe(WITH_BOTS)
    expect(mainMenu()).toBe(LEGACY)
    expect(await send("1")).toBe(networkMenu())
    h.state.sessions.set(FROM, { step: "BOGUS", dialingPhone: ME })
    expect(await send("x")).toBe(WITH_BOTS)
  })

  it("MAIN keywords \"pay bills\" / \"network plans\" open their item when it is visible", async () => {
    on()
    expect(await send("Pay Bills")).toBe("Pay Bills\n1. Ghana Water\n2. DStv\n0. Back")
    expect(session()?.step).toBe("PB_BILLER")
    atMain()
    expect(await send("network plans")).toBe("Network Plans\n1. MTN\n2. Telecel\n3. AT\n0. Back")
    expect(session()?.step).toBe("NP_NETWORK")
    atMain()
    expect(await send("paybill")).toBe("Pay Bills\n1. Ghana Water\n2. DStv\n0. Back")
    // only Pay Bills visible: it is digit 5 and the keyword follows it; "network plans" is not a menu word
    h.state.vis = { networkPlans: false, payBills: true, cashbackAirtime: false }
    atMain()
    expect(await send("pay bills")).toBe("Pay Bills\n1. Ghana Water\n2. DStv\n0. Back")
    atMain()
    expect(await send("network plans")).toBe("")
    expect(session()).toBeUndefined()
  })

  it("MAIN keywords with the switches off: escape to the AI exactly as today (session deleted)", async () => {
    for (const t of ["pay bills", "network plans"]) {
      atMain()
      expect(await send(t)).toBe("")
      expect(session()).toBeUndefined()
    }
    expect(h.catalog).not.toHaveBeenCalled()
  })

  it("Network Plans keyword is hidden by the data whitelist like its menu item", async () => {
    on()
    h.state.sessions.set(FROM, { step: "MAIN", dialingPhone: ME, dataBlocked: true })
    expect(await send("network plans")).toBe("")
    expect(session()).toBeUndefined()
  })

  it("only Pay Bills on: it takes digit 5", async () => {
    h.state.vis = { networkPlans: false, payBills: true, cashbackAirtime: false }
    expect(await send("9")).toBe(LEGACY.replace("\n0. Exit", "\n5. Pay Bills\n0. Exit"))
    expect(await send("5")).toContain("Pay Bills\n1. Ghana Water\n2. DStv\n0. Back")
  })
})

describe("Network Plans through the router", () => {
  it("end to end: shopId null, the sender is the buyer, the TYPED number is charged", async () => {
    on()
    expect(await send("5")).toBe("Network Plans\n1. MTN\n2. Telecel\n3. AT\n0. Back")
    expect(await send("1")).toBe("MTN\nSelect type:\n1. Data\n0. Back")
    expect(await send("1")).toBe("MTN Data\n1. 10.50 Data 1GB Bundle\n2. 11.50 Data 2GB Bundle\n3. 12.50 Data 3GB Bundle\n0. Back")
    expect(await send("1")).toBe("Recipient:\n1. My number\n2. Other number\n0. Back")
    expect(await send("my number")).toBe(PROMPT) // natural reply mapped to "1"
    expect(session()).toMatchObject({ step: "NP_PAY_PHONE", npRecipient: ME })
    expect(await send(PAY)).toBe(NP_CONFIRM)
    expect(h.createBundle).not.toHaveBeenCalled()
    expect(await send("yes")).toBe(SENT)
    expect(h.catalog.mock.calls[0][1]).toEqual(BC)
    expect(h.createBundle).toHaveBeenCalledTimes(1)
    expect(h.createBundle.mock.calls[0][1]).toEqual(BC)
    expect(h.createBundle.mock.calls[0][2]).toMatchObject({ token: "tok-1", recipient: ME, expectedPay: 10.5 })
    expect(h.charge).toHaveBeenCalledTimes(1)
    expect(h.charge.mock.calls[0][1]).toEqual({
      orderType: "cs_bundle", orderId: "np-order-1", botSurface: "whatsapp", shopId: null, dialingPhone: ME, payPhone: PAY,
    })
    expect(session()).toBeUndefined() // the flow ended: the chat goes back to the AI
  })

  it("the MoMo number step never maps free text to a number and never charges the sender", async () => {
    on()
    await send("5", "1", "1", "1", "1")
    for (const text of ["yes", "my number", "1", "me"]) {
      expect(await send(text)).toBe(`Invalid number.\n${PROMPT}`)
    }
    expect(session()?.step).toBe("NP_PAY_PHONE")
    expect(h.createBundle).not.toHaveBeenCalled()
    expect(h.charge).not.toHaveBeenCalled()
  })

  it("cancel at confirm (\"no\"), then \"1\" creates nothing", async () => {
    on()
    await send("5", "1", "1", "1", "1", PAY)
    expect(await send("no")).toBe("Order cancelled.")
    expect(await send("1")).toBe("Your session expired. Send a message to start a new order.")
    expect(h.createBundle).not.toHaveBeenCalled()
    expect(h.charge).not.toHaveBeenCalled()
  })

  it("free text inside the flow never escapes to the AI (the session is kept, the screen repaints)", async () => {
    on()
    await send("5")
    expect(await send("what is this?")).toBe("Network Plans\n1. MTN\n2. Telecel\n3. AT\n0. Back")
    expect(session()?.step).toBe("NP_NETWORK")
  })

  it("0 on the first screen goes back to the WhatsApp main menu", async () => {
    on()
    await send("5")
    expect(await send("0")).toBe(WITH_BOTS)
    expect(session()?.step).toBe("MAIN")
  })

  it("error texts: 409 / 429 / 403 / other, never the engine's own text", async () => {
    on()
    for (const [status, text] of [
      [409, "Price changed. Please try again."],
      [429, "Too many attempts. Please try later."],
      [403, "Not available right now."],
      [500, "Service unavailable. Please try again later."],
    ] as const) {
      atMain()
      h.createBundle.mockResolvedValueOnce({ ok: false, status, error: "provider secret detail" })
      expect(await send("5", "1", "1", "1", "1", PAY, "1")).toBe(text)
    }
    expect(h.charge).not.toHaveBeenCalled()
  })
})

describe("Pay Bills through the router", () => {
  it("Ghana Water end to end with an email: validated, carried to the lookup, typed number charged, shopId null", async () => {
    on()
    expect(await send("6")).toBe("Pay Bills\n1. Ghana Water\n2. DStv\n0. Back")
    expect(await send("1")).toBe("Enter meter number:\n0. Back")
    expect(await send("GW123456")).toBe("Enter the phone number linked to the meter:\n0. Back")
    expect(await send("0551234567")).toBe("Enter your email address (Ghana Water requires it):\n0. Back")
    expect(await send("kofi@mail")).toBe("Enter a valid email.\nEnter your email address (Ghana Water requires it):\n0. Back")
    expect(h.verifyBill).not.toHaveBeenCalled()
    expect(await send("kofi@mail.com")).toBe("Ghana Water GW123456\nName: K***h M***h\nDue: GHS 80.00\nEnter amount (GHS 1.00 - 5000.00):\n0. Back")
    expect(h.verifyBill.mock.calls[0][1]).toEqual(BC)
    expect(h.verifyBill.mock.calls[0][2]).toEqual({ biller: "ghana_water", account: "GW123456", phone: "0551234567", email: "kofi@mail.com" })
    expect(await send("80")).toBe(PROMPT)
    expect(await send(PAY)).toBe(`Pay GHS 79.20 (was GHS 80.00)\nYou get GHS 80.00 Ghana Water on GW123456\nMoMo: ${PAY}\n1. Confirm\n2. Cancel`)
    expect(await send("1")).toBe(SENT)
    expect(h.createBill.mock.calls[0][1]).toEqual(BC)
    expect(h.createBill.mock.calls[0][2]).toEqual({ token: "tok-ghana_water", amount: 80, expectedPay: 79.2 })
    expect(h.charge.mock.calls[0][1]).toEqual({
      orderType: "cs_bill", orderId: "pb-order-1", botSurface: "whatsapp", shopId: null, dialingPhone: ME, payPhone: PAY,
    })
    expect(session()).toBeUndefined()
  })

  it("cancel at confirm, then \"1\" creates nothing", async () => {
    on()
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
    h.charge.mockResolvedValueOnce(NEEDS)
    expect(await send("5", "1", "1", "1", "1", PAY, "1")).toBe(VERIFY)
    expect(h.sendPayerOtp).toHaveBeenCalledWith(PAY, ME)
    expect(session()).toMatchObject({ step: "NP_PAY_VERIFY", npOrderId: "np-order-1", npPayPhone: PAY })
    for (const text of ["yes", "cancel", "my number", "1"]) {
      expect(await send(text)).toBe(`Please reply with the 6-digit code.\n${VERIFY}`)
    }
    expect(h.verifyPayerOtp).not.toHaveBeenCalled()
    expect(h.failBotCharge).not.toHaveBeenCalled()
    expect(await send("000000")).toBe(`Wrong code. Try again.\n${VERIFY}`)
    expect(await send("123456")).toBe(SENT)
    expect(h.charge).toHaveBeenCalledTimes(2)
    expect(h.charge.mock.calls[1][1]).toEqual(h.charge.mock.calls[0][1])
    expect(h.createBundle).toHaveBeenCalledTimes(1)
    expect(session()).toBeUndefined()
  })

  it("0 cancels the order (Pay Bills)", async () => {
    on()
    h.charge.mockResolvedValueOnce(NEEDS)
    expect(await send("6", "2", "7012345678", "50", PAY, "1")).toBe(VERIFY)
    expect(await send("0")).toBe("Order cancelled.")
    expect(h.charge).toHaveBeenCalledTimes(1)
    expect(session()).toBeUndefined()
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
    expect(session()).toBeUndefined()
  })

  it("0 cancels: guarded fail of payment + order, the WhatsApp pointer is cleared", async () => {
    on()
    sendOtpCharge()
    await send("6", "2", "7012345678", "50", PAY, "1")
    expect(await send("0")).toBe("Order cancelled.")
    expect(h.failBotCharge).toHaveBeenCalledWith(h.db, "cs_bill", "pb-order-1", "pay-ref", expect.any(String))
    expect(h.clear).toHaveBeenCalledWith(ME, "whatsapp")
    expect(session()).toBeUndefined()
  })

  it("an older pointer (not from this charge) never takes over the chat", async () => {
    on()
    h.state.pointer = {
      reference: "old", orderType: "cs_bundle", orderId: "old-order", createdAt: new Date(Date.now() - 60_000).toISOString(), phone: ME, channel: "whatsapp",
    }
    expect(await send("5", "1", "1", "1", "1", PAY, "1")).toBe(SENT)
    expect(session()).toBeUndefined()
  })
})

describe("switches off: today's router behaviour pinned", () => {
  it("MAIN free text that is no keyword returns '' (the AI answers) and deletes the session", async () => {
    expect(await send("hello, what do you sell?")).toBe("")
    expect(session()).toBeUndefined()
    expect(h.vis).not.toHaveBeenCalled() // no keyword => not even the switches are read
  })

  it("a MAIN ordering keyword opens the legacy flow", async () => {
    expect(await send("I want data")).toBe(networkMenu())
    expect(session()).toMatchObject({ step: "SELECT_NETWORK" })
    expect(h.catalog).not.toHaveBeenCalled()
  })

  it("a SUBMIT_OTP session without botOtp goes to the legacy handleSubmitOtp, never to submitBotOtp", async () => {
    h.state.pointer = {
      reference: "pay-ref", orderType: "cs_bill", orderId: "pb-order-1", createdAt: new Date().toISOString(), phone: ME, channel: "whatsapp",
    }
    const legacy = { step: "SUBMIT_OTP", dialingPhone: ME, pendingOrderId: "ord-1" }
    h.state.sessions.set(FROM, { ...legacy })
    expect(await send("123456")).toBe("LEGACY-OTP-REPLY")
    expect(h.legacySubmitOtp).toHaveBeenCalledTimes(1)
    expect(h.legacySubmitOtp.mock.calls[0][0]).toBe("123456")
    expect(h.legacySubmitOtp.mock.calls[0][1]).toBe(FROM)
    expect(h.legacySubmitOtp.mock.calls[0][2]).toMatchObject(legacy)
    expect(h.submitBotOtp).not.toHaveBeenCalled()
  })
})

describe("no-session OTP fallback (webhook: the send_otp hand-off read failed, the chat has no session)", () => {
  const live = (o: Record<string, unknown> = {}) => {
    h.state.pointer = {
      reference: "pay-ref", orderType: "cs_bill", orderId: "pb-order-1", createdAt: new Date().toISOString(), phone: ME, channel: "whatsapp", ...o,
    }
  }
  beforeEach(() => { h.state.sessions.clear() })

  it("an OTP-shaped reply with this sender's pointer goes to submitBotOtp (ok => approve text, no session left)", async () => {
    live()
    expect(await waMainBotOtpFallback(FROM, " 123456 ")).toBe(APPROVE)
    expect(h.peek).toHaveBeenCalledWith(ME, "whatsapp")
    for (const c of h.peek.mock.calls) expect(c[0]).toBe(ME) // only ever the sender's own pointer
    expect(h.submitBotOtp).toHaveBeenCalledTimes(1)
    expect((h.submitBotOtp.mock.calls as unknown as unknown[][])[0][1]).toMatchObject({ reference: "pay-ref", phone: ME })
    expect((h.submitBotOtp.mock.calls as unknown as unknown[][])[0][2]).toBe("123456")
    expect(session()).toBeUndefined()
  })

  it("a wrong code puts the chat on SUBMIT_OTP (botOtp) so the next reply, incl. 0, reaches the bot OTP step", async () => {
    live()
    h.state.submit = { ok: false, retry: true }
    expect(await waMainBotOtpFallback(FROM, "1111")).toBe(`Wrong code. Try again.\n${OTP_PROMPT}`)
    expect(session()).toEqual({ step: "SUBMIT_OTP", dialingPhone: ME, botOtp: true })
    expect(await send("0")).toBe("Order cancelled.")
    expect(h.failBotCharge).toHaveBeenCalledWith(h.db, "cs_bill", "pb-order-1", "pay-ref", expect.any(String))
    expect(h.clear).toHaveBeenCalledWith(ME, "whatsapp")
  })

  it("no pointer => null (the webhook goes on to the AI exactly as before); nothing is submitted", async () => {
    expect(await waMainBotOtpFallback(FROM, "123456")).toBeNull()
    expect(h.submitBotOtp).not.toHaveBeenCalled()
    expect(session()).toBeUndefined()
  })

  it("only 4-8 digits are OTP-shaped: anything else is null without even reading the pointer", async () => {
    live()
    for (const t of ["123", "123456789", "hello", "12 34", "1", "0", "", "12345a"]) {
      expect(await waMainBotOtpFallback(FROM, t)).toBeNull()
    }
    expect(h.peek).not.toHaveBeenCalled()
    expect(h.submitBotOtp).not.toHaveBeenCalled()
  })

  it("the shop bot's pointer (or a Uzo one) for the same sender is never used by the main bot", async () => {
    live({ channel: "whatsapp_shop" })
    expect(await waMainBotOtpFallback(FROM, "123456")).toBeNull()
    live({ channel: undefined })
    expect(await waMainBotOtpFallback(FROM, "123456")).toBeNull()
    expect(h.submitBotOtp).not.toHaveBeenCalled()
  })

  it("a pointer read error or a non-Ghana sender => null (fail closed to today's path)", async () => {
    h.peek.mockRejectedValueOnce(new Error("redis down"))
    expect(await waMainBotOtpFallback(FROM, "123456")).toBeNull()
    live()
    expect(await waMainBotOtpFallback("4412345", "123456")).toBeNull()
    expect(h.submitBotOtp).not.toHaveBeenCalled()
  })
})
