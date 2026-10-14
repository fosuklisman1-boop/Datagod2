import { describe, expect, it } from "vitest"
import {
  airtimeStorefrontPrice, bundlePriceParts, isFinalView, orderView, parseAirtimeTerms, parseStorefrontCatalog, validateBuyer,
} from "./ui-helpers"

const terms = { applied: true, rate: 3, share: 100, feeRate: 0, maxFace: 100 }

describe("parseAirtimeTerms", () => {
  it("reads the network entry; null when missing, not applied or malformed", () => {
    expect(parseAirtimeTerms({ cashback: { MTN: { applied: true, rate: 3, share: 100, feeRate: 1.5, maxFace: 100 } } }, "MTN"))
      .toEqual({ applied: true, rate: 3, share: 100, feeRate: 1.5, maxFace: 100 })
    expect(parseAirtimeTerms({ cashback: { MTN: { applied: false, rate: 0, share: 0 } } }, "MTN")).toBeNull()
    expect(parseAirtimeTerms({ cashback: { MTN: { applied: true } } }, "MTN")).toBeNull()
    expect(parseAirtimeTerms({}, "MTN")).toBeNull()
    expect(parseAirtimeTerms(null, "MTN")).toBeNull()
    expect(parseAirtimeTerms({ cashback: { MTN: { applied: true, rate: 3, share: 100 } } }, null)).toBeNull()
  })
})

describe("airtimeStorefrontPrice", () => {
  it("GHS 3.00 at 3% x 100% share pays 2.91", () => {
    const p = airtimeStorefrontPrice(3, terms)
    expect(p).toMatchObject({ applied: true, face: 3, pay: 2.91, customerCashback: 0.09, paymentFee: 0 })
  })
  it("adds the payment fee on the discounted base, rounded up", () => {
    const p = airtimeStorefrontPrice(10, { ...terms, feeRate: 1.5 })
    expect(p.applied).toBe(true)
    expect(p.customerCashback).toBe(0.3)
    expect(p.paymentFee).toBe(0.15)
    expect(p.pay).toBe(9.85)
  })
  it("not applied above maxFace, without terms, or for a bad amount", () => {
    expect(airtimeStorefrontPrice(150, terms)).toMatchObject({ applied: false, pay: 150 })
    expect(airtimeStorefrontPrice(150, { ...terms, maxFace: null }).applied).toBe(true)
    expect(airtimeStorefrontPrice(10, null)).toMatchObject({ applied: false, pay: 10 })
    expect(airtimeStorefrontPrice(NaN, terms).applied).toBe(false)
    expect(airtimeStorefrontPrice(0, terms).applied).toBe(false)
  })
  it("shop-only split (customer share 0) is applied: no discount, pay = face + fee", () => {
    const p = airtimeStorefrontPrice(10, { ...terms, share: 0, feeRate: 1.5 })
    expect(p).toMatchObject({ applied: true, face: 10, customerCashback: 0, paymentFee: 0.15, pay: 10.15 })
    expect(airtimeStorefrontPrice(10, { ...terms, share: 0, feeRate: 0 })).toMatchObject({ applied: true, pay: 10 })
    // tiny face: commission rounds to nothing, still applied (server keeps a shop-only split applied too)
    expect(airtimeStorefrontPrice(0.1, { ...terms, share: 0 })).toMatchObject({ applied: true, pay: 0.1 })
  })
})

describe("catalog + price parts", () => {
  const good = { value: "1GB", display: "1 GB", amount: 5, category: "Daily", token: "t", payAmount: 4.9, customerCashback: 0.1, paymentFee: 0 }
  it("parses, dropping malformed bundles and empty categories", () => {
    const out = parseStorefrontCatalog({ categories: [{ name: "Daily", bundles: [good, { value: 1 }, null] }, { name: "Empty", bundles: [] }] })
    expect(out).toHaveLength(1)
    expect(out[0].bundles).toEqual([good])
    expect(parseStorefrontCatalog(null)).toEqual([])
    expect(parseStorefrontCatalog({ categories: "x" })).toEqual([])
  })
  it("shows 'was' only when the customer pays less than list", () => {
    expect(bundlePriceParts(good)).toEqual({ now: "GHS 4.90", was: "was GHS 5.00" })
    expect(bundlePriceParts({ amount: 5, payAmount: 5.08 })).toEqual({ now: "GHS 5.08", was: null })
    expect(bundlePriceParts({ amount: 5, payAmount: 5 })).toEqual({ now: "GHS 5.00", was: null })
  })
})

describe("validateBuyer", () => {
  it("needs a plausible email and a Ghana mobile", () => {
    expect(validateBuyer({ email: "a@b.co", phone: "0241234567" })).toBeNull()
    expect(validateBuyer({ email: "nope", phone: "0241234567" })).toMatch(/email/i)
    expect(validateBuyer({ email: "a@b.co", phone: "123" })).toMatch(/phone/i)
  })
})

describe("direct MoMo charge helpers", () => {
  it("momoNetworkLabel: network from the prefix (any Ghana format); null for non-MoMo numbers", async () => {
    const { momoNetworkLabel } = await import("./ui-helpers")
    expect(momoNetworkLabel("0241234567")).toBe("MTN MoMo")
    expect(momoNetworkLabel("233551234567")).toBe("MTN MoMo")
    expect(momoNetworkLabel("0501234567")).toBe("Telecel Cash")
    expect(momoNetworkLabel("0271234567")).toBe("AT Money")
    expect(momoNetworkLabel("0281234567")).toBeNull()
    expect(momoNetworkLabel("123")).toBeNull()
  })
  it("isDirectChargeOffResponse only for the 400 DIRECT_CHARGE_OFF answer", async () => {
    const { isDirectChargeOffResponse } = await import("./ui-helpers")
    expect(isDirectChargeOffResponse(400, { code: "DIRECT_CHARGE_OFF" })).toBe(true)
    expect(isDirectChargeOffResponse(400, { error: "x" })).toBe(false)
    expect(isDirectChargeOffResponse(403, { code: "DIRECT_CHARGE_OFF" })).toBe(false)
  })
})

describe("orderView", () => {
  it("maps status to the confirmation view", () => {
    expect(orderView("completed", "paid")).toBe("delivered")
    expect(orderView("failed", "paid")).toBe("failed")
    expect(orderView("pending", "unpaid")).toBe("awaiting_payment")
    expect(orderView("pending", "paid")).toBe("processing")
    expect(orderView("processing", "paid")).toBe("processing")
    expect(orderView(undefined, undefined)).toBe("processing")
    expect(isFinalView("delivered")).toBe(true)
    expect(isFinalView("failed")).toBe(true)
    expect(isFinalView("processing")).toBe(false)
  })
  it("refunding / refunded get their own views (no endless spinner)", () => {
    expect(orderView("refunding", "paid")).toBe("refunding")
    expect(orderView("refunded", "refunded")).toBe("refunded")
    expect(orderView("refunded", "paid")).toBe("refunded")
    expect(orderView("failed", "refunded")).toBe("refunded")
    expect(orderView("reversed", "paid")).toBe("failed")
    expect(isFinalView("refunding")).toBe(true)
    expect(isFinalView("refunded")).toBe(true)
  })
})

import {
  billStorefrontPrice, isOtpPhone, isOtpRequiredResponse, parseBillAmount, parseBillVerify, parseStorefrontBillers, suggestedAmountText,
} from "./ui-helpers"

describe("bills helpers", () => {
  const biller = { key: "ecg", label: "ECG", logo: "/billers/ecg.png", inputHint: "Meter number", page: "bills", min: 1, max: 5000, terms: { applied: true, rate: 2, share: 50, feeRate: 1.5 } }

  it("parseStorefrontBillers keeps good entries and defaults terms", () => {
    const out = parseStorefrontBillers([biller, { key: "x" }, null, { ...biller, key: "dstv", terms: undefined }])
    expect(out.map(b => b.key)).toEqual(["ecg", "dstv"])
    expect(out[1].terms).toEqual({ applied: false, rate: 0, share: 0, feeRate: 0 })
    expect(parseStorefrontBillers("nope")).toEqual([])
  })

  it("billStorefrontPrice: cashback then fee on the discounted base", () => {
    const p = billStorefrontPrice(100, "ecg", biller.terms)
    expect(p.customerCashback).toBe(1)
    expect(p.paymentFee).toBe(1.49)
    expect(p.pay).toBe(100.49)
  })
  it("billStorefrontPrice: fee only when cashback not applied; face when nothing applies", () => {
    expect(billStorefrontPrice(100, "ecg", { applied: false, rate: 0, share: 0, feeRate: 1 })).toEqual({ pay: 101, customerCashback: 0, paymentFee: 1 })
    expect(billStorefrontPrice(100, "ecg", { applied: false, rate: 0, share: 0, feeRate: 0 })).toEqual({ pay: 100, customerCashback: 0, paymentFee: 0 })
    expect(billStorefrontPrice(0, "ecg", biller.terms).pay).toBe(0)
  })

  it("parseBillAmount enforces 2 decimals and limits", () => {
    expect(parseBillAmount("20.5", 1, 100)).toBe(20.5)
    expect(parseBillAmount("20.555", 1, 100)).toBeNull()
    expect(parseBillAmount("0.5", 1, 100)).toBeNull()
    expect(parseBillAmount("101", 1, 100)).toBeNull()
    expect(parseBillAmount("", 1, 100)).toBeNull()
  })
  it("suggestedAmountText", () => {
    expect(suggestedAmountText(12.5)).toBe("12.50")
    expect(suggestedAmountText(0)).toBe("")
    expect(suggestedAmountText(undefined)).toBe("")
  })

  it("parseBillVerify reads a single account and a meter list, and errors", () => {
    const one = parseBillVerify({ success: true, customerName: "KOF***", amountDue: 40, suggestedAmount: 40, token: "t" })
    expect(one).toMatchObject({ ok: true, token: "t", name: "KOF***", due: 40, suggested: 40, meters: [] })
    const many = parseBillVerify({ success: true, meters: [{ meter: "123", name: "A***", outstanding: null, token: "m" }, { meter: 5 }] })
    expect(many).toMatchObject({ ok: true, token: null })
    expect(many.ok && many.meters).toEqual([{ meter: "123", name: "A***", outstanding: null, token: "m" }])
    expect(parseBillVerify({ error: "Not available" })).toEqual({ ok: false, error: "Not available" })
    expect(parseBillVerify(null)).toMatchObject({ ok: false })
  })

  it("OTP helpers", () => {
    expect(isOtpRequiredResponse(403, { code: "OTP_REQUIRED" })).toBe(true)
    expect(isOtpRequiredResponse(400, { code: "OTP_REQUIRED" })).toBe(false)
    expect(isOtpRequiredResponse(403, { error: "x" })).toBe(false)
    expect(isOtpPhone("0241234567")).toBe(true)
    expect(isOtpPhone("123")).toBe(false)
  })
})

import { billNeedsReverify } from "./ui-helpers"
describe("billNeedsReverify", () => {
  it("409 without a quote and 400 'verify again' drop the token; price changes and other errors keep it", () => {
    expect(billNeedsReverify(409, { error: "This verification was already used, please verify again" })).toBe(true)
    expect(billNeedsReverify(409, { error: "Price updated", quote: { payAmount: 1 } })).toBe(false)
    expect(billNeedsReverify(400, { error: "Please verify the account again" })).toBe(true)
    expect(billNeedsReverify(400, { error: "Enter a valid email address" })).toBe(false)
    expect(billNeedsReverify(500, null)).toBe(false)
  })
})
