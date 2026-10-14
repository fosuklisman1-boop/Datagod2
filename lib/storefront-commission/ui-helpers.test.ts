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
})
