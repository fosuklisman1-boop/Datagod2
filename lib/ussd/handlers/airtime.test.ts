// Main Uzo USSD airtime handlers (also reused by the WhatsApp bot via `channel`).
// The "legacy" block pins today's screens, session writes, inserted row and charge amounts
// byte-for-byte; it was written before the cashback change and must stay green.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    inserts: [] as Array<{ table: string; row: any }>,
    updates: [] as Array<{ table: string; patch: any }>,
    rpcCalls: [] as Array<{ name: string; args: any }>,
    sessions: [] as Array<{ id: string; s: any }>,
    charges: [] as any[],
    afterFns: [] as Array<() => Promise<void>>,
    walletBalance: 100,
    dialer: {} as any,
    feeRate: { customer: 5, dealer: 2 },
    seq: 0,
    quote: null as any, // what quoteBotAirtime returns (null = cashback not applied)
    quoteCalls: [] as any[],
  }
  const fake = {
    from(table: string) {
      return {
        insert(rows: any) {
          const row = Array.isArray(rows) ? rows[0] : rows
          state.inserts.push({ table, row })
          const res = { data: null, error: null }
          return {
            select: () => ({ single: async () => ({ data: { id: `order-${++state.seq}` }, error: null }) }),
            then: (ok: any, ko: any) => Promise.resolve(res).then(ok, ko),
          }
        },
        update(patch: any) {
          state.updates.push({ table, patch })
          return { eq: async () => ({ data: null, error: null }) }
        },
        select() {
          return {
            eq: () => ({
              maybeSingle: async () => ({ data: table === "wallets" ? { balance: state.walletBalance } : null, error: null }),
            }),
          }
        },
      }
    },
    rpc: async (name: string, args: any) => {
      state.rpcCalls.push({ name, args })
      return { data: [{ new_balance: state.walletBalance - args.p_amount, old_balance: state.walletBalance }], error: null }
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => { h.state.afterFns.push(fn) } }))
vi.mock("@/lib/ussd/session", () => ({
  setSession: vi.fn(async (id: string, s: any) => { h.state.sessions.push({ id, s }) }),
}))
vi.mock("@/lib/ussd/resolve-dialer", () => ({ resolveDialer: vi.fn(async () => ({ ...h.state.dialer })) }))
vi.mock("@/lib/ussd/resolve-email", () => ({ resolveEmail: vi.fn(async () => "payer@example.com") }))
vi.mock("@/lib/paystack", () => ({
  chargeMobileMoney: vi.fn(async (args: any) => { h.state.charges.push(args); return { status: "pay_offline" } }),
}))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: vi.fn(async () => {}),
  SMSTemplates: {
    ussdAirtimePaymentReceived: (...a: any[]) => `sms:${a.join("|")}`,
    ussdOtpRequired: () => "otp",
  },
}))
vi.mock("@/lib/whatsapp-bot/send", () => ({ sendWhatsAppText: vi.fn(async () => {}) }))
vi.mock("@/lib/secure-random", () => ({ secureReference: () => "AT-REF-001" }))
vi.mock("@/lib/ussd-service-visibility", () => ({
  getUssdServiceVisibility: vi.fn(async () => ({ data: true, afa: true, airtime: true, resultsChecker: true })),
}))
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
  airtimeBaseFeeRate: vi.fn(async (_n: string, isDealer: boolean) => (isDealer ? h.state.feeRate.dealer : h.state.feeRate.customer)),
}))

import {
  handleAirtimeEnterRecipient, handleAirtimeSelectNetwork, handleAirtimeEnterAmount,
  handleAirtimeConfirm, handleAirtimePaymentMethod,
} from "./airtime"

const DIALER = "0201112222"
const RECIPIENT = "0241234567"
const lastSession = () => h.state.sessions[h.state.sessions.length - 1]?.s
const airtimeInserts = () => h.state.inserts.filter(i => i.table === "airtime_orders").map(i => i.row)

async function flushAfter() {
  const fns = h.state.afterFns.splice(0)
  const p = Promise.all(fns.map(f => f()))
  await vi.advanceTimersByTimeAsync(5000)
  await p
}

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
  dialing_phone: DIALER,
  channel: "ussd",
}

const LEGACY_CONFIRM =
  "Confirm Airtime\nYellow Plans to 0241234567\nYou pay GHS 10.50\nThey get GHS 10.00\nfrom 0201112222\n\n1. Pay now\n2. Cancel"

const confirmSession = (extra: any = {}) => ({
  step: "AIRTIME_CONFIRM", dialingPhone: DIALER, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN",
  airtimeAmount: 10.5, airtimeFee: 0.5, airtimeToDeliver: 10, ...extra,
}) as any

beforeEach(() => {
  vi.useFakeTimers()
  h.state.inserts = []; h.state.updates = []; h.state.rpcCalls = []; h.state.sessions = []
  h.state.charges = []; h.state.afterFns = []; h.state.walletBalance = 100; h.state.dialer = {}; h.state.seq = 0
  h.state.quote = null; h.state.quoteCalls = []
})
afterEach(() => { vi.useRealTimers() })

describe("main USSD airtime: legacy (no cashback) is byte-identical", () => {
  it("recipient entry asks for the amount to pay", async () => {
    const r = await handleAirtimeEnterRecipient(RECIPIENT, "s1", { step: "AIRTIME_ENTER_RECIPIENT", dialingPhone: DIALER } as any)
    expect(r).toEqual({ message: "Yellow Plans Airtime\nEnter amount to pay\n(GHS 1 - 500):\n\n0. Back", ussdServiceOp: 2 })
    expect(lastSession()).toEqual({ step: "AIRTIME_ENTER_AMOUNT", dialingPhone: DIALER, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN" })
  })

  it("network pick asks for the amount to pay", async () => {
    const r = await handleAirtimeSelectNetwork("2", "s1", { step: "AIRTIME_SELECT_NETWORK", dialingPhone: DIALER, airtimeRecipient: "0311234567" } as any)
    expect(r.message).toBe("Tele Airtime\nEnter amount to pay\n(GHS 1 - 500):\n\n0. Back")
  })

  it("amount entry shows today's fee-inclusive confirm screen", async () => {
    const r = await handleAirtimeEnterAmount("10.50", "s1", { step: "AIRTIME_ENTER_AMOUNT", dialingPhone: DIALER, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN" } as any)
    expect(r).toEqual({ message: LEGACY_CONFIRM, ussdServiceOp: 2 })
    expect(lastSession()).toEqual({
      step: "AIRTIME_CONFIRM", dialingPhone: DIALER, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN",
      airtimeAmount: 10.5, airtimeFee: 0.5, airtimeToDeliver: 10, userId: undefined, walletBalance: undefined,
    })
  })

  it("invalid amount re-prompts", async () => {
    const r = await handleAirtimeEnterAmount("abc", "s1", { step: "AIRTIME_ENTER_AMOUNT", dialingPhone: DIALER, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN" } as any)
    expect(r.message).toBe("Enter a valid amount.\nYellow Plans Airtime\nEnter amount to pay\n(GHS 1 - 500):\n\n0. Back")
  })

  it("confirm (MoMo only) inserts today's row and charges the typed amount", async () => {
    const r = await handleAirtimeConfirm("1", "s1", confirmSession())
    expect(r).toEqual({
      message: "MoMo prompt sent to 0201112222. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.",
      ussdServiceOp: 17,
    })
    expect(airtimeInserts()).toEqual([LEGACY_ROW])
    await flushAfter()
    expect(h.state.charges).toHaveLength(1)
    expect(h.state.charges[0]).toMatchObject({ amount: 10.5, phone: DIALER, provider: "vod", reference: "order-1" })
  })

  it("confirm with a funded wallet offers the wallet, which deducts the typed amount", async () => {
    h.state.dialer = { userId: "u1", role: "dealer", balance: 50, email: "d@example.com" }
    h.state.feeRate.dealer = 2
    const s = confirmSession({ airtimeAmount: 10.2, airtimeFee: 0.2, airtimeToDeliver: 10 })
    const r = await handleAirtimeConfirm("1", "s1", s)
    expect(r).toEqual({ message: "Pay GHS 10.20\n1. Datagod Wallet\n   (GHS 50.00)\n2. MoMo prompt\n0. Cancel", ussdServiceOp: 2 })
    expect(airtimeInserts()).toEqual([{
      ...LEGACY_ROW, airtime_amount: 10, fee_amount: 0.2, total_paid: 10.2, user_id: "u1", customer_email: "d@example.com",
    }])
    const pm = await handleAirtimePaymentMethod("1", "s1", lastSession())
    expect(pm.message).toBe("Payment successful.\nAirtime will reflect\nshortly.")
    expect(h.state.rpcCalls).toEqual([{ name: "deduct_wallet", args: { p_user_id: "u1", p_amount: 10.2 } }])
    const tx = h.state.inserts.find(i => i.table === "transactions")!.row
    expect(tx.amount).toBe(10.2)
    const upd = h.state.updates.filter(u => u.table === "airtime_orders").map(u => Object.keys(u.patch).sort())
    expect(upd).toEqual([["payment_status", "status", "updated_at"]])
  })

  it("WhatsApp confirm inserts the same row and charges the typed amount", async () => {
    await handleAirtimeConfirm("1", "wa1", confirmSession(), "whatsapp")
    expect(airtimeInserts()).toEqual([LEGACY_ROW])
    await flushAfter()
    expect(h.state.charges[0]).toMatchObject({ amount: 10.5 })
  })
})

// ── Cashback ───────────────────────────────────────────────────────────────────
// Main menu: customer share only (shopShare ignored), rail paystack.
const QUOTE = {
  applied: true, faceAmount: 10, rate: 10, share: 50, commission: 1, customerCashback: 0.5, shopShare: 0,
  payAmount: 9.69, datagodKeeps: 0.5, provider: "hubtel", base: 9.5, paymentFee: 0.19, feeRate: 1.95,
}
const onFor = (over: any = {}) => (face: number) => ({ ...QUOTE, faceAmount: face, ...over })

const CASHBACK_CONFIRM =
  "Confirm Airtime\nPay GHS 9.69 (was GHS 10.00)\nYou get GHS 10.00 Yellow Plans airtime\nTo: 0241234567\nMoMo: 0201112222\n1. Confirm\n2. Cancel"

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

const cbConfirmSession = (extra: any = {}) => confirmSession({
  airtimeAmount: 10, airtimeFee: 0, airtimeToDeliver: 10, airtimeCashbackPay: 9.69, ...extra,
})

describe("main USSD airtime: cashback applied", () => {
  it("asks for the airtime amount, probing at the minimum on rail paystack (main share)", async () => {
    h.state.quote = onFor()
    const r = await handleAirtimeEnterRecipient(RECIPIENT, "s1", { step: "AIRTIME_ENTER_RECIPIENT", dialingPhone: DIALER } as any, "ussd")
    expect(r.message).toBe("Yellow Plans Airtime\nEnter airtime amount\n(GHS 1 - 500):\n\n0. Back")
    expect(h.state.quoteCalls[0]).toEqual(["MTN", 1, { rail: "paystack", shop: false }])
    const r2 = await handleAirtimeSelectNetwork("1", "s1", { step: "AIRTIME_SELECT_NETWORK", dialingPhone: DIALER, airtimeRecipient: "0311234567" } as any, "ussd")
    expect(r2.message).toBe("Yellow Plans Airtime\nEnter airtime amount\n(GHS 1 - 500):\n\n0. Back")
    const r3 = await handleAirtimeEnterAmount("x", "s1", { step: "AIRTIME_ENTER_AMOUNT", dialingPhone: DIALER, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN" } as any, "ussd")
    expect(r3.message).toBe("Enter a valid amount.\nYellow Plans Airtime\nEnter airtime amount\n(GHS 1 - 500):\n\n0. Back")
  })

  it("amount is the face: confirm shows Pay x (was y) and stores the shown price", async () => {
    h.state.quote = onFor()
    const r = await handleAirtimeEnterAmount("10", "s1", { step: "AIRTIME_ENTER_AMOUNT", dialingPhone: DIALER, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN" } as any, "ussd")
    expect(r).toEqual({ message: CASHBACK_CONFIRM, ussdServiceOp: 2 })
    expect(lastSession()).toMatchObject({ step: "AIRTIME_CONFIRM", airtimeAmount: 10, airtimeFee: 0, airtimeToDeliver: 10, airtimeCashbackPay: 9.69 })
    expect(h.state.quoteCalls.at(-1)).toEqual(["MTN", 10, { rail: "paystack", shop: false }])
    // Junk input repaints the same cashback screen.
    const again = await handleAirtimeConfirm("9", "s1", lastSession())
    expect(again.message).toBe(CASHBACK_CONFIRM)
  })

  it("confirm (MoMo) inserts the cashback row and charges payAmount (= total_paid)", async () => {
    h.state.quote = onFor()
    const r = await handleAirtimeConfirm("1", "s1", cbConfirmSession())
    expect(r.ussdServiceOp).toBe(17)
    expect(airtimeInserts()).toEqual([CASHBACK_ROW])
    await flushAfter()
    expect(h.state.charges).toHaveLength(1)
    expect(h.state.charges[0]).toMatchObject({ amount: 9.69, reference: "order-1" })
    expect(h.state.inserts.find(i => i.table === "payment_attempts")!.row.amount).toBe(9.69)
  })

  it("a shop share in the quote is never credited on the main menu", async () => {
    h.state.quote = onFor({ shopShare: 0.3 })
    await handleAirtimeConfirm("1", "s1", cbConfirmSession())
    expect(airtimeInserts()[0]).toMatchObject({ merchant_commission: 0, shop_share_amount: 0, shop_id: null })
  })

  it("dealer wallet stays: it pays the quote's base (no payment fee) and the row is re-priced to base", async () => {
    h.state.quote = onFor()
    // 9.60 covers base 9.50 but not payAmount 9.69: the wallet is still offered.
    h.state.dialer = { userId: "u1", role: "dealer", balance: 9.6, email: "d@example.com" }
    const r = await handleAirtimeConfirm("1", "s1", cbConfirmSession())
    expect(r.message).toBe("Pay by:\n1. Datagod Wallet\n   GHS 9.50 (bal 9.60)\n2. MoMo prompt\n   GHS 9.69\n0. Cancel")
    // Inserted before the method is chosen: MoMo pricing.
    expect(airtimeInserts()).toEqual([{ ...CASHBACK_ROW, user_id: "u1", customer_email: "d@example.com" }])
    h.state.walletBalance = 9.6
    const pm = await handleAirtimePaymentMethod("1", "s1", lastSession())
    expect(pm.message).toBe("Payment successful.\nAirtime will reflect\nshortly.")
    expect(h.state.rpcCalls).toEqual([{ name: "deduct_wallet", args: { p_user_id: "u1", p_amount: 9.5 } }])
    expect(h.state.inserts.find(i => i.table === "transactions")!.row.amount).toBe(9.5)
    const upd = h.state.updates.filter(u => u.table === "airtime_orders").map(u => u.patch)
    expect(upd).toHaveLength(1)
    expect(upd[0]).toMatchObject({
      payment_status: "completed", status: "pending", total_paid: 9.5, payment_fee_amount: 0, fee_amount: 0,
    })
    // Cashback snapshot columns are untouched by the wallet re-price.
    expect(Object.keys(upd[0]).filter(k => k.startsWith("cashback") || k === "shop_share_amount" || k === "airtime_amount")).toEqual([])
  })

  it("wallet short of base: refused with the base as the amount needed, no debit", async () => {
    h.state.quote = onFor()
    h.state.dialer = { userId: "u1", role: "dealer", balance: 9.6 }
    await handleAirtimeConfirm("1", "s1", cbConfirmSession())
    h.state.walletBalance = 9.4
    const pm = await handleAirtimePaymentMethod("1", "s1", lastSession())
    expect(pm.message).toBe("Insufficient balance.\nWallet: GHS 9.40\nNeeded: GHS 9.50\n\n2. Pay via MoMo\n0. Cancel")
    expect(h.state.rpcCalls).toEqual([])
  })

  it("wallet below base: no wallet offer, straight to MoMo at payAmount", async () => {
    h.state.quote = onFor()
    h.state.dialer = { userId: "u1", role: "dealer", balance: 9.4 }
    const r = await handleAirtimeConfirm("1", "s1", cbConfirmSession())
    expect(r.ussdServiceOp).toBe(17)
    await flushAfter()
    expect(h.state.charges[0]).toMatchObject({ amount: 9.69 })
  })

  it("wallet screen -> MoMo charges payAmount and leaves the row's price alone", async () => {
    h.state.quote = onFor()
    h.state.dialer = { userId: "u1", role: "customer", balance: 50 }
    await handleAirtimeConfirm("1", "s1", cbConfirmSession())
    await handleAirtimePaymentMethod("2", "s1", lastSession())
    await flushAfter()
    expect(h.state.charges[0]).toMatchObject({ amount: 9.69 })
    expect(h.state.updates.filter(u => u.table === "airtime_orders" && "total_paid" in u.patch)).toEqual([])
  })

  it("re-quote mismatch at confirm: 'Price changed. Please try again.' and no order", async () => {
    h.state.quote = onFor({ payAmount: 9.8 })
    const r = await handleAirtimeConfirm("1", "s1", cbConfirmSession())
    expect(r).toEqual({ message: "Price changed. Please try again.", ussdServiceOp: 17 })
    expect(airtimeInserts()).toEqual([])
    expect(h.state.afterFns).toHaveLength(0)
  })

  it("cashback switched off or on since the screen: same refusal, no order", async () => {
    h.state.quote = null
    expect((await handleAirtimeConfirm("1", "s1", cbConfirmSession())).message).toBe("Price changed. Please try again.")
    h.state.quote = onFor()
    expect((await handleAirtimeConfirm("1", "s1", confirmSession())).message).toBe("Price changed. Please try again.")
    expect(airtimeInserts()).toEqual([])
  })
})

describe("main USSD airtime: cashback not applied on the USSD channel stays byte-identical", () => {
  it("screens, session and row match today's", async () => {
    const r1 = await handleAirtimeEnterRecipient(RECIPIENT, "s1", { step: "AIRTIME_ENTER_RECIPIENT", dialingPhone: DIALER } as any, "ussd")
    expect(r1.message).toBe("Yellow Plans Airtime\nEnter amount to pay\n(GHS 1 - 500):\n\n0. Back")
    const r2 = await handleAirtimeEnterAmount("10.50", "s1", { step: "AIRTIME_ENTER_AMOUNT", dialingPhone: DIALER, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN" } as any, "ussd")
    expect(r2.message).toBe(LEGACY_CONFIRM)
    expect(lastSession()).toEqual({
      step: "AIRTIME_CONFIRM", dialingPhone: DIALER, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN",
      airtimeAmount: 10.5, airtimeFee: 0.5, airtimeToDeliver: 10, userId: undefined, walletBalance: undefined,
    })
    await handleAirtimeConfirm("1", "s1", confirmSession())
    expect(airtimeInserts()).toEqual([LEGACY_ROW])
    await flushAfter()
    expect(h.state.charges[0]).toMatchObject({ amount: 10.5 })
  })
})

describe("WhatsApp reuse stays byte-identical even with cashback ON", () => {
  it("entry handlers (called without a channel, as the WhatsApp router does) show today's screens", async () => {
    h.state.quote = onFor()
    const r1 = await handleAirtimeEnterRecipient(RECIPIENT, "wa1", { step: "AIRTIME_ENTER_RECIPIENT", dialingPhone: DIALER } as any)
    expect(r1.message).toBe("Yellow Plans Airtime\nEnter amount to pay\n(GHS 1 - 500):\n\n0. Back")
    const r2 = await handleAirtimeSelectNetwork("2", "wa1", { step: "AIRTIME_SELECT_NETWORK", dialingPhone: DIALER, airtimeRecipient: "0311234567" } as any)
    expect(r2.message).toBe("Tele Airtime\nEnter amount to pay\n(GHS 1 - 500):\n\n0. Back")
    const r3 = await handleAirtimeEnterAmount("10.50", "wa1", { step: "AIRTIME_ENTER_AMOUNT", dialingPhone: DIALER, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN" } as any)
    expect(r3.message).toBe(LEGACY_CONFIRM)
    expect(lastSession()).toEqual({
      step: "AIRTIME_CONFIRM", dialingPhone: DIALER, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN",
      airtimeAmount: 10.5, airtimeFee: 0.5, airtimeToDeliver: 10, userId: undefined, walletBalance: undefined,
    })
    expect(h.state.quoteCalls).toEqual([])
  })

  it("whatsapp confirm + payment method insert today's row and charge today's amount", async () => {
    h.state.quote = onFor()
    await handleAirtimeConfirm("1", "wa1", confirmSession(), "whatsapp")
    expect(airtimeInserts()).toEqual([LEGACY_ROW])
    await flushAfter()
    expect(h.state.charges[0]).toMatchObject({ amount: 10.5 })

    h.state.dialer = { userId: "u1", role: "customer", balance: 50, email: "c@example.com" }
    const r = await handleAirtimeConfirm("1", "wa1", confirmSession(), "whatsapp")
    expect(r.message).toBe("Pay GHS 10.50\n1. Datagod Wallet\n   (GHS 50.00)\n2. MoMo prompt\n0. Cancel")
    await handleAirtimePaymentMethod("1", "wa1", lastSession(), "whatsapp")
    expect(h.state.rpcCalls).toEqual([{ name: "deduct_wallet", args: { p_user_id: "u1", p_amount: 10.5 } }])
    expect(h.state.quoteCalls).toEqual([])
  })
})
