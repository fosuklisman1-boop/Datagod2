// Shop Uzo USSD airtime handlers. The "legacy" block pins today's screens, inserted row
// (shop markup -> merchant_commission) and charge amount; it was written before the cashback
// change and must stay green.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    inserts: [] as Array<{ table: string; row: any }>,
    updates: [] as Array<{ table: string; patch: any }>,
    sessions: [] as Array<{ id: string; s: any }>,
    charges: [] as any[],
    afterFns: [] as Array<() => Promise<void>>,
    markup: 3,
    ownerRole: "agent",
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
          const data = table === "user_shops" ? { user_id: "owner-1", airtime_markup_mtn: state.markup }
            : table === "users" ? { role: state.ownerRole } : null
          return { eq: () => ({ single: async () => ({ data, error: null }), maybeSingle: async () => ({ data, error: null }) }) }
        },
      }
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => { h.state.afterFns.push(fn) } }))
vi.mock("@/lib/ussd-shop/session", () => ({
  setSession: vi.fn(async (id: string, s: any) => { h.state.sessions.push({ id, s }) }),
}))
vi.mock("@/lib/ussd/resolve-email", () => ({ resolveEmail: vi.fn(async () => "payer@example.com") }))
vi.mock("@/lib/paystack", () => ({
  chargeMobileMoney: vi.fn(async (args: any) => { h.state.charges.push(args); return { status: "pay_offline" } }),
}))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: vi.fn(async () => {}),
  SMSTemplates: { ussdAirtimePaymentReceived: () => "sms", ussdOtpRequired: () => "otp" },
}))
vi.mock("@/lib/secure-random", () => ({ secureReference: () => "AT-REF-001" }))
vi.mock("@/lib/ussd-service-visibility", () => ({
  getUssdServiceVisibility: vi.fn(async () => ({ data: true, afa: true, airtime: true, resultsChecker: true })),
}))
vi.mock("@/lib/airtime-pricing", async (orig) => ({
  ...(await orig<typeof import("@/lib/airtime-pricing")>()),
  isAirtimeEnabled: vi.fn(async () => true),
  getAirtimeLimits: vi.fn(async () => ({ min: 1, max: 500 })),
  airtimeBaseFeeRate: vi.fn(async (_n: string, isDealer: boolean) => (isDealer ? 2 : 5)),
}))

import {
  handleShopAirtimeEnterRecipient, handleShopAirtimeSelectNetwork, handleShopAirtimeEnterAmount, handleShopAirtimeConfirm,
} from "./airtime"

const SHOP_ID = "0b6f3c1e-1d2a-4c3b-9e8f-123456789abc"
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

const base = { dialingPhone: DIALER, shopId: SHOP_ID, shopName: "Kofi Shop" }

const LEGACY_ROW = {
  reference_code: "AT-REF-001",
  network: "MTN",
  beneficiary_phone: RECIPIENT,
  airtime_amount: 10,
  fee_amount: 0.8,
  total_paid: 10.8,
  pay_separately: false,
  status: "pending_payment",
  payment_status: "pending_payment",
  user_id: null,
  shop_id: SHOP_ID,
  merchant_commission: 0.3,
  customer_name: "USSD Customer",
  customer_email: null,
  dialing_phone: DIALER,
  channel: "ussd_shop",
}

const LEGACY_CONFIRM =
  "Kofi Shop\nYellow Plans to 0241234567\nPay GHS 10.80\nGet GHS 10.00\nfrom 0201112222\n\n1. Pay now\n2. Cancel"

beforeEach(() => {
  vi.useFakeTimers()
  h.state.inserts = []; h.state.updates = []; h.state.sessions = []; h.state.charges = []; h.state.afterFns = []
  h.state.markup = 3; h.state.ownerRole = "agent"; h.state.seq = 0
})
afterEach(() => { vi.useRealTimers() })

describe("shop USSD airtime: legacy (no cashback) is byte-identical", () => {
  it("recipient entry asks for the amount to pay", async () => {
    const r = await handleShopAirtimeEnterRecipient(RECIPIENT, "s1", { step: "SHOP_AIRTIME_ENTER_RECIPIENT", ...base } as any)
    expect(r).toEqual({ message: "Yellow Plans Airtime\nEnter amount to pay\n(GHS 1 - 500):\n\n0. Back", ussdServiceOp: 2 })
    expect(lastSession()).toEqual({ step: "SHOP_AIRTIME_ENTER_AMOUNT", ...base, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN" })
  })

  it("network pick asks for the amount to pay", async () => {
    const r = await handleShopAirtimeSelectNetwork("3", "s1", { step: "SHOP_AIRTIME_SELECT_NETWORK", ...base, airtimeRecipient: "0311234567" } as any)
    expect(r.message).toBe("Instant Blue Airtime\nEnter amount to pay\n(GHS 1 - 500):\n\n0. Back")
  })

  it("amount entry shows today's markup-inclusive confirm screen", async () => {
    const r = await handleShopAirtimeEnterAmount("10.80", "s1", { step: "SHOP_AIRTIME_ENTER_AMOUNT", ...base, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN" } as any)
    expect(r).toEqual({ message: LEGACY_CONFIRM, ussdServiceOp: 2 })
    expect(lastSession()).toEqual({
      step: "SHOP_AIRTIME_CONFIRM", ...base, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN",
      airtimeAmount: 10.8, airtimeFee: 0.8, airtimeToDeliver: 10, airtimeMerchantCommission: 0.3,
    })
  })

  it("invalid amount re-prompts", async () => {
    const r = await handleShopAirtimeEnterAmount("0", "s1", { step: "SHOP_AIRTIME_ENTER_AMOUNT", ...base, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN" } as any)
    expect(r.message).toBe("Kofi Shop\nBuy Airtime\nEnter recipient number:\n\n0. Back")
    const r2 = await handleShopAirtimeEnterAmount("9999", "s1", { step: "SHOP_AIRTIME_ENTER_AMOUNT", ...base, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN" } as any)
    expect(r2.message).toBe("Enter a valid amount.\nYellow Plans Airtime\nEnter amount to pay\n(GHS 1 - 500):\n\n0. Back")
  })

  it("confirm inserts today's row (markup commission) and charges the typed amount", async () => {
    const s = {
      step: "SHOP_AIRTIME_CONFIRM", ...base, airtimeRecipient: RECIPIENT, airtimeNetwork: "MTN",
      airtimeAmount: 10.8, airtimeFee: 0.8, airtimeToDeliver: 10, airtimeMerchantCommission: 0.3,
    } as any
    const r = await handleShopAirtimeConfirm("1", "s1", s)
    expect(r).toEqual({
      message: "MoMo prompt sent to 0201112222. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.",
      ussdServiceOp: 17,
    })
    expect(airtimeInserts()).toEqual([LEGACY_ROW])
    await flushAfter()
    expect(h.state.charges).toHaveLength(1)
    expect(h.state.charges[0]).toMatchObject({ amount: 10.8, phone: DIALER, provider: "vod", reference: "order-1" })
    const pa = h.state.inserts.find(i => i.table === "payment_attempts")!.row
    expect(pa.amount).toBe(10.8)
  })
})
