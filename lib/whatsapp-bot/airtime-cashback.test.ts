// Router-level tests: airtime on the MAIN WhatsApp bot (waRouter -> lib/ussd/handlers/airtime.ts, channel 'whatsapp').
// - The "legacy" block pins today's WhatsApp airtime messages, inserted row, wallet debit and MoMo charge byte for
//   byte. It was written (and run green) BEFORE the cashback change and must stay green with the WhatsApp
//   cashbackAirtime switch off, and with it on while the quote is unusable.
// - Cashback (switch on + usable quote): customer share, no shop; MoMo charge = total_paid = payAmount (to the typed
//   number, reference = order id); the wallet pays base (no Paystack fee); fee_amount 0, fee in payment_fee_amount;
//   >2 decimals refused; a re-quote mismatch at confirm => "Price changed. Please try again." and no order.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    sessions: new Map<string, any>(),
    vis: { networkPlans: false, payBills: false, cashbackAirtime: false },
    inserts: [] as Array<{ table: string; row: any }>,
    updates: [] as Array<{ table: string; patch: any }>,
    rpcCalls: [] as Array<{ name: string; args: any }>,
    charges: [] as any[],
    afterFns: [] as Array<() => Promise<void>>,
    walletBalance: 100,
    dialer: {} as any,
    seq: 0,
    quote: null as any, // what quoteBotAirtime returns (null = cashback not applied)
    quoteCalls: [] as any[],
    uzoCashbackAirtime: true, // the Uzo switch: must never matter on WhatsApp
    pkgPrice: 10,             // packages.price (data bundles)
    // Per-account wallets (by user_id). null = every wallets read answers `walletBalance` (the older tests).
    wallets: null as null | Record<string, number>,
    walletReads: [] as string[], // the user_id of every wallets read
  }
  const db = {
    from(table: string) {
      let op: "select" | "insert" | "update" = "select"
      let userIdFilter: string | undefined
      const chain: any = new Proxy({}, {
        get(_t, prop) {
          if (prop === "eq") {
            return (col: string, v: any) => { if (col === "user_id") userIdFilter = v; return chain }
          }
          if (prop === "insert") {
            return (rows: any) => {
              op = "insert"
              state.inserts.push({ table, row: Array.isArray(rows) ? rows[0] : rows })
              return chain
            }
          }
          if (prop === "update") {
            return (patch: any) => { op = "update"; state.updates.push({ table, patch }); return chain }
          }
          if (prop === "single") {
            return async () => {
              if (op === "insert") return { data: { id: `order-${++state.seq}` }, error: null }
              if (table === "packages") return { data: { price: state.pkgPrice, dealer_price: null, is_available: true }, error: null }
              if (table === "app_settings") return { data: { paystack_fee_percentage: 3 }, error: null }
              return { data: null, error: null }
            }
          }
          if (prop === "maybeSingle") {
            return async () => {
              if (table !== "wallets") return { data: null, error: null }
              state.walletReads.push(String(userIdFilter))
              if (!state.wallets) return { data: { balance: state.walletBalance }, error: null }
              const b = userIdFilter !== undefined ? state.wallets[userIdFilter] : undefined
              return { data: b === undefined ? null : { balance: b }, error: null }
            }
          }
          if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: null, error: null })
          return () => chain
        },
      })
      return chain
    },
    rpc: async (name: string, args: any) => {
      state.rpcCalls.push({ name, args })
      return { data: [{ new_balance: state.walletBalance - args.p_amount, old_balance: state.walletBalance }], error: null }
    },
  }
  return { state, db, vis: vi.fn(async () => ({ ...state.vis })) }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.db }))
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => { h.state.afterFns.push(fn) } }))
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
  getUssdServiceVisibility: async () => ({
    data: true, afa: true, airtime: true, resultsChecker: true, cashbackAirtime: h.state.uzoCashbackAirtime,
  }),
}))
vi.mock("./cashback-visibility", () => ({ whatsappBotItemsVisible: h.vis }))
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
  airtimeBaseFeeRate: vi.fn(async (_n: string, isDealer: boolean) => (isDealer ? 2 : 5)),
}))
vi.mock("@/lib/ussd/resolve-dialer", () => ({ resolveDialer: vi.fn(async () => ({ ...h.state.dialer })) }))
vi.mock("@/lib/ussd/resolve-email", () => ({ resolveEmail: vi.fn(async () => "payer@example.com") }))
vi.mock("@/lib/paystack", () => ({
  chargeMobileMoney: vi.fn(async (args: any) => { h.state.charges.push(args); return { status: "pay_offline" } }),
  submitOtp: vi.fn(),
}))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: vi.fn(async () => {}),
  SMSTemplates: { ussdAirtimePaymentReceived: (...a: any[]) => `sms:${a.join("|")}`, ussdOtpRequired: () => "otp" },
}))
vi.mock("@/lib/whatsapp-bot/send", () => ({ sendWhatsAppText: vi.fn(async () => {}) }))
vi.mock("@/lib/secure-random", () => ({ secureReference: () => "AT-REF-001" }))
vi.mock("@/lib/results-checker-service", () => ({
  isExamBoardEnabled: vi.fn(async () => true),
  getAvailableCount: vi.fn(async () => 100),
  getMaxQuantity: vi.fn(async () => 50),
  getRCBulkHint: vi.fn(async () => null),
  calculateRCPrice: vi.fn(async () => ({ unitPrice: 20, totalPaid: 20, bulkApplied: false })),
}))

import { waRouter } from "./router"

const FROM = "233244123456" // the WhatsApp sender (Meta's wa_id); sessions are keyed by it
const ME = "0244123456"     // the same number, local form
const PAY = "0201234567"    // the typed MoMo number (Telecel => Paystack "vod")
const RECIPIENT = "0241234567"

const RECIPIENT_PROMPT_REPLY = "Yellow Plans Airtime\nEnter amount to pay\n(GHS 1 - 500):\n\n0. Back"
const LEGACY_CONFIRM =
  "Confirm Airtime\nMTN to 0241234567\nYou pay GHS 10.50\nThey get GHS 10.00\n\n1. Pay via Wallet\n   (GHS 0.00)\n2. Pay via MoMo\n0. Cancel"
const MOMO_PROMPT = "Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel"
const SENT = `MoMo prompt sent to ${PAY}. Approve to complete.\n\nIf you receive an OTP code, reply here with it.`
const PAID = "Payment successful.\nAirtime will reflect\nshortly."

const LEGACY_ROW = {
  reference_code: "AT-REF-001",
  network: "MTN",
  beneficiary_phone: RECIPIENT,
  airtime_amount: 10,
  fee_amount: 0.5,
  total_paid: 10.5,
  pay_separately: false,
  status: "pending_payment",
  payment_status: "pending_payment",
  user_id: null,
  shop_id: null,
  merchant_commission: 0,
  customer_name: "USSD Customer",
  customer_email: null,
  dialing_phone: PAY,
  channel: "ussd",
}

const session = () => h.state.sessions.get(FROM)
const airtimeInserts = () => h.state.inserts.filter(i => i.table === "airtime_orders").map(i => i.row)
async function send(...inputs: string[]): Promise<string> {
  let r = ""
  for (const m of inputs) r = await waRouter(FROM, m)
  return r
}
async function flushAfter() {
  const fns = h.state.afterFns.splice(0)
  const p = Promise.all(fns.map(f => f()))
  await vi.advanceTimersByTimeAsync(5000)
  await p
}
const atRecipient = () => h.state.sessions.set(FROM, { step: "AIRTIME_ENTER_RECIPIENT", dialingPhone: ME })

beforeEach(() => {
  vi.useFakeTimers()
  h.state.sessions.clear()
  h.state.vis = { networkPlans: false, payBills: false, cashbackAirtime: false }
  h.state.inserts = []; h.state.updates = []; h.state.rpcCalls = []; h.state.charges = []; h.state.afterFns = []
  h.state.walletBalance = 100; h.state.dialer = {}; h.state.seq = 0; h.state.wallets = null; h.state.walletReads = []
  h.state.quote = null; h.state.quoteCalls = []; h.state.uzoCashbackAirtime = true; h.state.pkgPrice = 10
  h.vis.mockClear()
  atRecipient()
})
afterEach(() => { vi.useRealTimers() })

/** Today's MoMo walk, asserted byte for byte. */
async function legacyMomoWalk() {
  expect(await send(RECIPIENT)).toBe(RECIPIENT_PROMPT_REPLY)
  expect(await send("10.50")).toBe(LEGACY_CONFIRM)
  expect(session()).toEqual({
    step: "AIRTIME_CONFIRM", dialingPhone: ME, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN",
    airtimeAmount: 10.5, airtimeFee: 0.5, airtimeToDeliver: 10,
  })
  expect(await send("2")).toBe(MOMO_PROMPT)
  expect(await send(PAY)).toBe(SENT)
  expect(airtimeInserts()).toEqual([LEGACY_ROW])
  await flushAfter()
  expect(h.state.charges).toHaveLength(1)
  expect(h.state.charges[0]).toEqual({
    email: "payer@example.com", amount: 10.5, phone: PAY, provider: "vod", reference: "order-1",
    metadata: { source: "ussd_airtime", airtime_order_id: "order-1", recipient_phone: RECIPIENT, network: "MTN" },
  })
  expect(h.state.inserts.find(i => i.table === "payment_attempts")!.row).toEqual({
    reference: "order-1", amount: 10.5, email: "payer@example.com", status: "pending", payment_type: "ussd_airtime", order_id: "order-1",
  })
  expect(h.state.rpcCalls).toEqual([])
}

/** Today's wallet walk (a customer with GHS 50), asserted byte for byte. */
async function legacyWalletWalk() {
  h.state.dialer = { userId: "u1", role: "customer", balance: 50, email: "c@example.com" }
  h.state.walletBalance = 50
  expect(await send(RECIPIENT)).toBe(RECIPIENT_PROMPT_REPLY)
  expect(await send("10.50")).toBe(LEGACY_CONFIRM.replace("(GHS 0.00)", "(GHS 50.00)"))
  expect(await send("1")).toBe(PAID)
  expect(airtimeInserts()).toEqual([{ ...LEGACY_ROW, user_id: "u1", customer_email: "c@example.com", dialing_phone: ME }])
  expect(h.state.rpcCalls).toEqual([{ name: "deduct_wallet", args: { p_user_id: "u1", p_amount: 10.5 } }])
  expect(h.state.inserts.find(i => i.table === "transactions")!.row).toMatchObject({ amount: 10.5, reference_id: "order-1" })
  const upd = h.state.updates.filter(u => u.table === "airtime_orders").map(u => Object.keys(u.patch).sort())
  expect(upd).toEqual([["channel"], ["payment_status", "status", "updated_at"]])
  expect(h.state.charges).toEqual([])
}

describe("main WhatsApp airtime: legacy (pinned before the cashback change)", () => {
  it("MoMo: screens, row and charge are today's", async () => {
    await legacyMomoWalk()
  })

  it("wallet: screens, row and debit are today's", async () => {
    await legacyWalletWalk()
  })

  it("invalid amount re-prompts with today's wording", async () => {
    await send(RECIPIENT)
    expect(await send("abc")).toBe("Enter a valid amount.\n" + RECIPIENT_PROMPT_REPLY)
  })

  it("the Uzo switch and an Uzo-usable quote never change WhatsApp", async () => {
    h.state.uzoCashbackAirtime = true
    h.state.quote = (face: number) => ({ ...QUOTE, faceAmount: face })
    await legacyMomoWalk()
    expect(h.state.quoteCalls).toEqual([])
  })
})

// ── Cashback ──────────────────────────────────────────────────────────────────
const QUOTE = {
  applied: true, faceAmount: 10, rate: 10, share: 50, commission: 1, customerCashback: 0.5, shopShare: 0,
  payAmount: 9.69, datagodKeeps: 0.5, provider: "hubtel", base: 9.5, paymentFee: 0.19, feeRate: 1.95,
}
const onFor = (over: any = {}) => (face: number) => ({ ...QUOTE, faceAmount: face, ...over })
const cashbackOn = (over: any = {}) => {
  h.state.vis = { networkPlans: false, payBills: false, cashbackAirtime: true }
  h.state.quote = onFor(over)
}

const CB_AMOUNT_PROMPT = "Yellow Plans Airtime\nEnter airtime amount\n(GHS 1 - 500):\n\n0. Back"
const cbConfirm = (balance: string) =>
  "Confirm Airtime\nMTN to 0241234567\nPay GHS 9.69 (was GHS 10.00)\nThey get GHS 10.00 airtime\n\n" +
  `1. Pay via Wallet\n   GHS 9.50 (bal ${balance})\n2. Pay via MoMo\n   GHS 9.69\n0. Cancel`
const PRICE_CHANGED = "Price changed. Please try again."

const CASHBACK_ROW = {
  ...LEGACY_ROW,
  airtime_amount: 10,
  fee_amount: 0, // ruling: the Paystack fee lives in payment_fee_amount only
  total_paid: 9.69,
  merchant_commission: 0,
  payment_fee_amount: 0.19,
  cashback_amount: 0.5,
  shop_share_amount: 0,
  cashback_rate: 10,
  cashback_share: 50,
  cashback_provider: "hubtel",
  expected_commission: 1,
}

describe("main WhatsApp airtime: cashback applied (WhatsApp switch on + usable quote)", () => {
  it("asks for the airtime amount; every quote is rail paystack, customer share (no shop)", async () => {
    cashbackOn()
    expect(await send(RECIPIENT)).toBe(CB_AMOUNT_PROMPT)
    expect(h.state.quoteCalls[0]).toEqual(["MTN", 1, { rail: "paystack", shop: false }])
    expect(await send("abc")).toBe("Enter a valid amount.\n" + CB_AMOUNT_PROMPT)
  })

  it("MoMo: confirm shows Pay x (was y); the typed number is charged payAmount = total_paid, reference = order id", async () => {
    cashbackOn()
    await send(RECIPIENT)
    expect(await send("10")).toBe(cbConfirm("0.00"))
    expect(session()).toMatchObject({
      step: "AIRTIME_CONFIRM", airtimeAmount: 10, airtimeFee: 0, airtimeToDeliver: 10, airtimeCashbackPay: 9.69,
    })
    expect(h.state.quoteCalls.at(-1)).toEqual(["MTN", 10, { rail: "paystack", shop: false }])
    // Junk repaints the cashback screen.
    expect(await send("9")).toBe(cbConfirm("0.00"))
    expect(await send("2")).toBe(MOMO_PROMPT)
    expect(await send(PAY)).toBe(SENT)
    expect(airtimeInserts()).toEqual([CASHBACK_ROW])
    await flushAfter()
    expect(h.state.charges).toHaveLength(1)
    expect(h.state.charges[0]).toMatchObject({ amount: 9.69, phone: PAY, provider: "vod", reference: "order-1" })
    expect(h.state.inserts.find(i => i.table === "payment_attempts")!.row.amount).toBe(9.69)
    expect(h.state.rpcCalls).toEqual([])
  })

  it("MoMo with a funded wallet on the typed number: still charges payAmount, row price untouched", async () => {
    cashbackOn()
    await send(RECIPIENT, "10", "2")
    h.state.dialer = { userId: "u2", role: "customer", balance: 50 }
    expect(await send(PAY)).toBe(SENT)
    await flushAfter()
    expect(h.state.charges[0]).toMatchObject({ amount: 9.69, phone: PAY })
    expect(h.state.updates.filter(u => u.table === "airtime_orders" && "total_paid" in u.patch)).toEqual([])
    expect(h.state.rpcCalls).toEqual([])
  })

  it("wallet pays base (no Paystack fee): offered when the balance covers base but not payAmount", async () => {
    cashbackOn()
    h.state.dialer = { userId: "u1", role: "dealer", balance: 9.6, email: "d@example.com" }
    h.state.walletBalance = 9.6
    await send(RECIPIENT)
    expect(await send("10")).toBe(cbConfirm("9.60"))
    expect(await send("1")).toBe(PAID)
    expect(airtimeInserts()).toEqual([{ ...CASHBACK_ROW, user_id: "u1", customer_email: "d@example.com", dialing_phone: ME }])
    expect(h.state.rpcCalls).toEqual([{ name: "deduct_wallet", args: { p_user_id: "u1", p_amount: 9.5 } }])
    expect(h.state.inserts.find(i => i.table === "transactions")!.row.amount).toBe(9.5)
    const reprice = h.state.updates.filter(u => u.table === "airtime_orders" && "total_paid" in u.patch).map(u => u.patch)
    expect(reprice).toHaveLength(1)
    expect(reprice[0]).toMatchObject({ payment_status: "completed", status: "pending", total_paid: 9.5, payment_fee_amount: 0, fee_amount: 0 })
    expect(h.state.charges).toEqual([])
  })

  it("wallet below base: 'Wallet balance too low' and the MoMo number is asked (never the sender's)", async () => {
    cashbackOn()
    h.state.dialer = { userId: "u1", role: "dealer", balance: 9.4 }
    await send(RECIPIENT, "10")
    expect(await send("1")).toBe("Wallet balance too low.\n" + MOMO_PROMPT)
    expect(airtimeInserts()).toEqual([])
    expect(await send(PAY)).toBe(SENT)
    await flushAfter()
    expect(h.state.charges[0]).toMatchObject({ amount: 9.69, phone: PAY })
  })

  it("more than 2 decimals is refused on the cashback branch; no confirm", async () => {
    cashbackOn()
    await send(RECIPIENT)
    expect(await send("10.555")).toBe("Enter a valid amount.\n" + CB_AMOUNT_PROMPT)
    expect(session().step).toBe("AIRTIME_ENTER_AMOUNT")
    expect(await send("10.55")).toContain("Pay GHS 9.69 (was GHS 10.55)")
  })

  it("re-quote mismatch at confirm (MoMo): 'Price changed. Please try again.' and no order, no charge", async () => {
    cashbackOn()
    await send(RECIPIENT, "10", "2")
    h.state.quote = onFor({ payAmount: 9.8 })
    expect(await send(PAY)).toBe(PRICE_CHANGED)
    expect(airtimeInserts()).toEqual([])
    expect(h.state.afterFns).toHaveLength(0)
  })

  it("re-quote mismatch at confirm (wallet) or cashback switched off since the screen: same refusal", async () => {
    cashbackOn()
    h.state.dialer = { userId: "u1", role: "customer", balance: 50 }
    await send(RECIPIENT, "10")
    h.state.vis = { networkPlans: false, payBills: false, cashbackAirtime: false }
    expect(await send("1")).toBe(PRICE_CHANGED)
    expect(airtimeInserts()).toEqual([])
    expect(h.state.rpcCalls).toEqual([])
  })
})

describe("main WhatsApp airtime: cashback NOT applied stays byte-identical", () => {
  it("switch off (key missing / false) with a usable quote: today's walk, the quote is never asked", async () => {
    h.state.quote = onFor()
    await legacyMomoWalk()
    expect(h.state.quoteCalls).toEqual([])
  })

  it("switch on, no quote (gate off / provider earns nothing): today's MoMo walk", async () => {
    h.state.vis = { networkPlans: false, payBills: false, cashbackAirtime: true }
    await legacyMomoWalk()
  })

  it("switch on, no quote: today's wallet walk", async () => {
    h.state.vis = { networkPlans: false, payBills: false, cashbackAirtime: true }
    await legacyWalletWalk()
  })

  for (const [label, over] of [
    ["not applied", { applied: false }],
    ["NaN payAmount", { payAmount: NaN }],
    ["base above payAmount", { base: 9.8 }],
    ["negative cashback", { customerCashback: -1 }],
  ] as const) {
    it(`switch on, unusable quote (${label}): today's walk`, async () => {
      cashbackOn(over)
      // The prompt probe only checks applied + payAmount (Plan 2/3 rule, same as Uzo); from the amount on, an
      // unusable quote prices exactly as today.
      await send(RECIPIENT)
      expect(await send("10.50")).toBe(LEGACY_CONFIRM)
      expect(session().airtimeCashbackPay).toBeUndefined()
      expect(await send("2")).toBe(MOMO_PROMPT)
      expect(await send(PAY)).toBe(SENT)
      expect(airtimeInserts()).toEqual([LEGACY_ROW])
      await flushAfter()
      expect(h.state.charges[0]).toMatchObject({ amount: 10.5, phone: PAY, reference: "order-1" })
    })
  }
})

// ── Rulings 2026-10-21 ────────────────────────────────────────────────────────
/** An AIRTIME_CONFIRM session as lib/ai-tools.ts stages it: today's pricing, no cashback price. */
const aiStaged = (extra: any = {}) => ({
  step: "AIRTIME_CONFIRM", dialingPhone: ME, airtimeNetwork: "MTN", airtimeRecipient: RECIPIENT,
  airtimeAmount: 10.5, airtimeFee: 0.5, airtimeToDeliver: 10, ...extra,
})
const WALLET_SHORT = "Wallet balance too low.\n" + MOMO_PROMPT

describe("ruling 1: confirm honours the pricing mode the session was staged with", () => {
  it("AI-staged airtime with cashback ON (MoMo): charged the legacy price shown, not refused", async () => {
    cashbackOn()
    h.state.sessions.set(FROM, aiStaged())
    expect(await send("2")).toBe(MOMO_PROMPT)
    expect(await send(PAY)).toBe(SENT)
    expect(airtimeInserts()).toEqual([LEGACY_ROW])
    await flushAfter()
    expect(h.state.charges[0]).toMatchObject({ amount: 10.5, phone: PAY, reference: "order-1" })
  })

  it("AI-staged airtime with cashback ON (wallet): debits the legacy price shown", async () => {
    cashbackOn()
    h.state.dialer = { userId: "u1", role: "customer", balance: 50, email: "c@example.com" }
    h.state.walletBalance = 50
    h.state.sessions.set(FROM, aiStaged({ userId: "u1", walletBalance: 50 }))
    expect(await send("1")).toBe(PAID)
    expect(airtimeInserts()).toEqual([{ ...LEGACY_ROW, user_id: "u1", customer_email: "c@example.com", dialing_phone: ME }])
    expect(h.state.rpcCalls).toEqual([{ name: "deduct_wallet", args: { p_user_id: "u1", p_amount: 10.5 } }])
  })

  it("cashback-staged with a price mismatch is still refused", async () => {
    cashbackOn()
    await send(RECIPIENT, "10", "2")
    h.state.quote = onFor({ payAmount: 9.7 })
    expect(await send(PAY)).toBe(PRICE_CHANGED)
    expect(airtimeInserts()).toEqual([])
  })
})

describe("ruling 2: a live wallet shortfall never sends a MoMo prompt to the sender's number", () => {
  it("airtime (legacy): the cached balance passed, the live one is short => ask for the MoMo number, no order", async () => {
    h.state.dialer = { userId: "u1", role: "customer", balance: 5 } // live
    h.state.wallets = { u1: 5 } // live, read by the session's account
    h.state.sessions.set(FROM, aiStaged({ userId: "u1", walletBalance: 50 })) // cached
    expect(await send("1")).toBe(WALLET_SHORT)
    expect(session()).toMatchObject({ step: "WA_ENTER_PAYMENT_PHONE", waNextStep: "CONFIRM_AIRTIME" })
    expect(airtimeInserts()).toEqual([])
    expect(h.state.afterFns).toHaveLength(0)
    // The typed number is then charged (never the sender's).
    expect(await send(PAY)).toBe(SENT)
    await flushAfter()
    expect(h.state.charges).toHaveLength(1)
    expect(h.state.charges[0]).toMatchObject({ amount: 10.5, phone: PAY })
  })

  it("airtime (cashback): live balance below base => ask for the MoMo number, then payAmount to the typed number", async () => {
    cashbackOn()
    h.state.dialer = { userId: "u1", role: "dealer", balance: 9.6 }
    await send(RECIPIENT, "10")
    h.state.dialer = { userId: "u1", role: "dealer", balance: 9.0 }
    h.state.wallets = { u1: 9.0 }
    expect(await send("1")).toBe(WALLET_SHORT)
    expect(airtimeInserts()).toEqual([])
    expect(h.state.afterFns).toHaveLength(0)
    expect(await send(PAY)).toBe(SENT)
    await flushAfter()
    expect(h.state.charges[0]).toMatchObject({ amount: 9.69, phone: PAY })
  })

  it("results checker: same fix (live price/balance short at confirm)", async () => {
    h.state.dialer = { userId: "u1", role: "customer", balance: 5 }
    h.state.wallets = { u1: 5 }
    h.state.sessions.set(FROM, {
      step: "RC_CONFIRM", dialingPhone: ME, rcBoard: "WASSCE", rcQty: 1, rcTotal: 20, userId: "u1", walletBalance: 50,
    })
    expect(await send("1")).toBe(WALLET_SHORT)
    expect(session()).toMatchObject({ step: "WA_ENTER_PAYMENT_PHONE", waNextStep: "CONFIRM_RC" })
    expect(h.state.inserts.filter(i => i.table === "results_checker_orders")).toEqual([])
    expect(h.state.afterFns).toHaveLength(0)
  })

  it("data bundles: same fix (verified price a pesewa above the cached balance)", async () => {
    h.state.pkgPrice = 10.005
    h.state.wallets = { u1: 10 } // the live wallet is a pesewa short too
    h.state.sessions.set(FROM, {
      step: "CONFIRM", dialingPhone: ME, network: "MTN", bundleId: "p1", bundleSize: "1", bundlePrice: 10,
      recipientPhone: RECIPIENT, userId: "u1", walletBalance: 10, paystackProvider: "mtn",
    })
    expect(await send("1")).toBe(WALLET_SHORT)
    expect(session()).toMatchObject({ step: "WA_ENTER_PAYMENT_PHONE", waNextStep: "CONFIRM_BUNDLE" })
    expect(h.state.inserts.filter(i => i.table === "ussd_orders")).toEqual([])
    expect(h.state.afterFns).toHaveLength(0)
  })

  const dataConfirm = (extra: any = {}) => ({
    step: "CONFIRM", dialingPhone: ME, network: "MTN", bundleId: "p1", bundleSize: "1", bundlePrice: 10,
    recipientPhone: RECIPIENT, userId: "u1", walletBalance: 50, paystackProvider: "mtn", ...extra,
  })

  it("data bundles: the cached balance passed, the LIVE one is short => ask for the MoMo number, no pending order row", async () => {
    h.state.dialer = { userId: "u1", role: "customer", balance: 5 } // live
    h.state.wallets = { u1: 5 }
    h.state.sessions.set(FROM, dataConfirm()) // cached 50
    expect(await send("1")).toBe(WALLET_SHORT)
    expect(session()).toMatchObject({ step: "WA_ENTER_PAYMENT_PHONE", waNextStep: "CONFIRM_BUNDLE" })
    expect(h.state.inserts.filter(i => i.table === "ussd_orders")).toEqual([])
    expect(h.state.afterFns).toHaveLength(0)
    expect(h.state.charges).toHaveLength(0)
  })

  // An OTP-linked WhatsApp account (lib/ai-tools.ts stages session.userId = the linked account, registered on ANOTHER
  // phone): the sender's own number resolves to no account (or another one). The wallet of the SESSION's account pays.
  const LINKED = { u1: 50 }

  it("data bundles, OTP-linked account: the session account's live wallet pays (not the sender phone's account)", async () => {
    h.state.dialer = {} // the sender's phone is not the account's phone
    h.state.wallets = LINKED
    h.state.sessions.set(FROM, dataConfirm())
    expect(await send("1")).not.toBe(WALLET_SHORT)
    expect(h.state.walletReads).toContain("u1")
    expect(h.state.inserts.filter(i => i.table === "ussd_orders")).toHaveLength(1)
    expect(h.state.charges).toHaveLength(0)
    expect(h.state.rpcCalls).toContainEqual({ name: "deduct_wallet", args: expect.objectContaining({ p_user_id: "u1" }) })
  })

  it("data bundles, OTP-linked account with another account on the sender phone: still the session account", async () => {
    h.state.dialer = { userId: "u2", role: "customer", balance: 0 }
    h.state.wallets = { u1: 50, u2: 0 }
    h.state.sessions.set(FROM, dataConfirm())
    expect(await send("1")).not.toBe(WALLET_SHORT)
    expect(h.state.walletReads).not.toContain("u2")
  })

  it("airtime, OTP-linked account: the session account's live wallet pays", async () => {
    h.state.dialer = {}
    h.state.wallets = LINKED
    h.state.sessions.set(FROM, aiStaged({ userId: "u1", walletBalance: 50 }))
    expect(await send("1")).toBe(PAID)
    expect(airtimeInserts()[0]).toMatchObject({ user_id: "u1" })
    expect(h.state.rpcCalls).toEqual([{ name: "deduct_wallet", args: { p_user_id: "u1", p_amount: 10.5 } }])
    expect(h.state.charges).toHaveLength(0)
  })

  it("results checker, OTP-linked account: the session account's live wallet pays (no MoMo prompt)", async () => {
    h.state.dialer = {}
    h.state.wallets = LINKED
    h.state.sessions.set(FROM, {
      step: "RC_CONFIRM", dialingPhone: ME, rcBoard: "WASSCE", rcQty: 1, rcTotal: 20, userId: "u1", walletBalance: 50,
    })
    expect(await send("1")).not.toBe(WALLET_SHORT)
    expect(h.state.walletReads).toContain("u1")
    expect(h.state.charges).toHaveLength(0)
    expect(h.state.afterFns).toHaveLength(0)
  })

  it("no session account => short, whatever the sender phone's account holds (data)", async () => {
    h.state.dialer = { userId: "u2", role: "customer", balance: 500 }
    h.state.wallets = { u2: 500 }
    h.state.sessions.set(FROM, dataConfirm({ userId: undefined }))
    expect(await send("1")).toBe(WALLET_SHORT)
    expect(h.state.inserts).toEqual([])
  })

  it("data bundles, Uzo path (no walletOnly): the cached balance decides, no live read (unchanged)", async () => {
    const { handleConfirm } = await import("@/lib/ussd/handlers/bundles")
    const { resolveDialer } = await import("@/lib/ussd/resolve-dialer")
    vi.mocked(resolveDialer).mockClear()
    h.state.dialer = { userId: "u1", role: "customer", balance: 5 }
    const r = await handleConfirm("1", "uzo-session", dataConfirm() as any, "ussd")
    expect(resolveDialer).not.toHaveBeenCalled()
    expect(r.message).toContain("(GHS 50.00)") // the payment-method screen shows the cached balance
    expect(h.state.inserts.filter(i => i.table === "ussd_orders")).toHaveLength(1)
  })

  it("data bundles: a live balance that covers the price still creates the order (wallet path)", async () => {
    h.state.dialer = { userId: "u1", role: "customer", balance: 50 }
    h.state.wallets = { u1: 50 }
    h.state.sessions.set(FROM, dataConfirm())
    expect(await send("1")).not.toBe(WALLET_SHORT)
    expect(h.state.inserts.filter(i => i.table === "ussd_orders")).toHaveLength(1)
    expect(h.state.charges).toHaveLength(0)
  })
})
