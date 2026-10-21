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
  }
  const db = {
    from(table: string) {
      let op: "select" | "insert" | "update" = "select"
      const chain: any = new Proxy({}, {
        get(_t, prop) {
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
            return async () => (op === "insert" ? { data: { id: `order-${++state.seq}` }, error: null } : { data: null, error: null })
          }
          if (prop === "maybeSingle") {
            return async () => ({ data: table === "wallets" ? { balance: state.walletBalance } : null, error: null })
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
  h.state.walletBalance = 100; h.state.dialer = {}; h.state.seq = 0
  h.state.quote = null; h.state.quoteCalls = []; h.state.uzoCashbackAirtime = true
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
