import { describe, it, expect, vi, beforeEach } from "vitest"
import type { StorefrontQuote } from "@/lib/cashback/quote"

const h = vi.hoisted(() => ({ quoteBotAirtime: vi.fn() }))
vi.mock("@/lib/cashback/storefront-airtime", () => ({ quoteBotAirtime: h.quoteBotAirtime }))

import {
  airtimeRequote, uzoAirtimeCashbackConfirm, uzoAirtimePromptCashback, uzoAirtimeQuote,
  uzoCashbackAirtimeColumns, uzoUsableAirtimeQuote,
} from "./airtime"
import { UZO_SCREEN_LIMIT } from "./screen"

const quote = (over: Partial<StorefrontQuote> = {}): StorefrontQuote => ({
  applied: true, faceAmount: 10, rate: 10, share: 50, commission: 1, customerCashback: 0.5, shopShare: 0,
  payAmount: 9.69, datagodKeeps: 0.5, provider: "hubtel", base: 9.5, paymentFee: 0.19, feeRate: 1.95, ...over,
})

beforeEach(() => { h.quoteBotAirtime.mockReset() })

describe("uzoAirtimeQuote", () => {
  it("quotes on rail paystack with the shop flag", async () => {
    h.quoteBotAirtime.mockResolvedValue(quote())
    await uzoAirtimeQuote("MTN", 10, false)
    await uzoAirtimeQuote("AT", 5, true)
    expect(h.quoteBotAirtime.mock.calls[0].slice(0, 3)).toEqual(["MTN", 10, { rail: "paystack", shop: false }])
    expect(h.quoteBotAirtime.mock.calls[1].slice(0, 3)).toEqual(["AT", 5, { rail: "paystack", shop: true }])
  })

  it("prompt probe: true only for an applied quote; any error => false", async () => {
    h.quoteBotAirtime.mockResolvedValueOnce(quote({ faceAmount: 1 }))
    expect(await uzoAirtimePromptCashback("MTN", 1, false)).toBe(true)
    expect(h.quoteBotAirtime.mock.calls[0].slice(0, 3)).toEqual(["MTN", 1, { rail: "paystack", shop: false }])
    h.quoteBotAirtime.mockResolvedValueOnce(null)
    expect(await uzoAirtimePromptCashback("MTN", 1, false)).toBe(false)
    h.quoteBotAirtime.mockRejectedValueOnce(new Error("db down"))
    expect(await uzoAirtimePromptCashback("MTN", 1, true)).toBe(false)
  })

  it("usable quote: must match the face and be finite and positive", async () => {
    h.quoteBotAirtime.mockResolvedValueOnce(quote())
    expect(await uzoUsableAirtimeQuote("MTN", 10, false)).toEqual(quote())
    h.quoteBotAirtime.mockResolvedValueOnce(quote({ faceAmount: 11 }))
    expect(await uzoUsableAirtimeQuote("MTN", 10, false)).toBeNull()
    h.quoteBotAirtime.mockResolvedValueOnce(quote({ payAmount: NaN }))
    expect(await uzoUsableAirtimeQuote("MTN", 10, false)).toBeNull()
    h.quoteBotAirtime.mockResolvedValueOnce(quote({ applied: false }))
    expect(await uzoUsableAirtimeQuote("MTN", 10, false)).toBeNull()
    // base is the wallet price: must be finite, positive and not above payAmount.
    for (const base of [NaN, 0, 9.7]) {
      h.quoteBotAirtime.mockResolvedValueOnce(quote({ base }))
      expect(await uzoUsableAirtimeQuote("MTN", 10, false)).toBeNull()
    }
  })
})

describe("airtimeRequote (stale-session guard)", () => {
  it("legacy when nothing was shown and nothing applies", () => {
    expect(airtimeRequote(undefined, null, 10)).toEqual({ kind: "legacy" })
  })
  it("cashback when the shown price still matches", () => {
    expect(airtimeRequote(9.69, quote(), 10)).toEqual({ kind: "cashback", quote: quote() })
  })
  it("changed when the price moved, cashback turned off, or turned on", () => {
    expect(airtimeRequote(9.69, quote({ payAmount: 9.7 }), 10)).toEqual({ kind: "changed" })
    expect(airtimeRequote(9.69, null, 10)).toEqual({ kind: "changed" })
    expect(airtimeRequote(undefined, quote(), 10)).toEqual({ kind: "changed" })
    expect(airtimeRequote(NaN, quote(), 10)).toEqual({ kind: "changed" })
    // base (the wallet price) above payAmount is not a usable quote.
    expect(airtimeRequote(9.69, quote({ base: 9.7 }), 10)).toEqual({ kind: "changed" })
    expect(airtimeRequote(undefined, quote({ base: 9.7 }), 10)).toEqual({ kind: "legacy" })
  })
})

describe("uzoCashbackAirtimeColumns", () => {
  it("main: face delivered, total = payAmount, fee_amount 0 (fee only in payment_fee_amount), no shop share", () => {
    expect(uzoCashbackAirtimeColumns(quote({ shopShare: 0.2 }), false)).toEqual({
      airtime_amount: 10, fee_amount: 0, total_paid: 9.69, payment_fee_amount: 0.19,
      cashback_amount: 0.5, shop_share_amount: 0, cashback_rate: 10, cashback_share: 50,
      cashback_provider: "hubtel", expected_commission: 1, merchant_commission: 0,
    })
  })
  it("shop: merchant_commission = shop share (no markup)", () => {
    const cols = uzoCashbackAirtimeColumns(quote({ shopShare: 0.25 }), true)
    expect(cols.merchant_commission).toBe(0.25)
    expect(cols.shop_share_amount).toBe(0.25)
  })
})

describe("uzoAirtimeCashbackConfirm", () => {
  it("shows Pay (was), what is received, recipient, payer and 1. Confirm / 2. Cancel", () => {
    expect(uzoAirtimeCashbackConfirm({ label: "Yellow Plans", recipient: "0241234567", pay: 9.69, face: 10, payer: "0201112222" }))
      .toBe("Pay GHS 9.69 (was GHS 10.00)\nYou get GHS 10.00 Yellow Plans airtime\nTo: 0241234567\nMoMo: 0201112222\n1. Confirm\n2. Cancel")
  })
  it("no (was) when pay >= face", () => {
    expect(uzoAirtimeCashbackConfirm({ label: "Tele", recipient: "0241234567", pay: 10.04, face: 10, payer: "0201112222" }))
      .not.toContain("was")
  })
  it("prepends the shop header only when it fits", () => {
    const short = uzoAirtimeCashbackConfirm({ header: "Kofi Shop", label: "Tele", recipient: "0241234567", pay: 9.69, face: 10, payer: "0201112222" })
    expect(short.startsWith("Kofi Shop\nPay GHS 9.69")).toBe(true)
    const long = uzoAirtimeCashbackConfirm({ header: "X".repeat(150), label: "Instant Blue", recipient: "0241234567", pay: 99999.99, face: 99999.99, payer: "0201112222" })
    expect(long.startsWith("Pay GHS")).toBe(true)
    expect(long.length).toBeLessThanOrEqual(UZO_SCREEN_LIMIT)
    expect(long.endsWith("1. Confirm\n2. Cancel")).toBe(true)
  })
})
