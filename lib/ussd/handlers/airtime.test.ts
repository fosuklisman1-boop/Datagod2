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
  })

  it("WhatsApp confirm inserts the same row and charges the typed amount", async () => {
    await handleAirtimeConfirm("1", "wa1", confirmSession(), "whatsapp")
    expect(airtimeInserts()).toEqual([LEGACY_ROW])
    await flushAfter()
    expect(h.state.charges[0]).toMatchObject({ amount: 10.5 })
  })
})
