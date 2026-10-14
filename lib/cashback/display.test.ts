import { describe, expect, it } from "vitest"
import { resolveCashbackConfig } from "./config"
import { quoteCashback } from "./quote"
import { airtimePagePrice, priceLabel, quoteForDisplay, shortfall } from "./display"

describe("airtimePagePrice", () => {
  const mtn = { provider: "hubtel", rate: 3.96, share: 25, maxFace: 100 }
  it("no rate entry: legacy fee total, toggle shown", () => {
    expect(airtimePagePrice(10, undefined, 10.7)).toEqual({ cashbackOn: false, pay: 10.7 })
  })
  it("entry + typed amount: cashback price", () => {
    expect(airtimePagePrice(10, mtn, 10.7)).toEqual({ cashbackOn: true, pay: 9.91 })
  })
  it("entry, nothing typed yet: cashback mode (toggle hidden)", () => {
    expect(airtimePagePrice(0, mtn, 0)).toEqual({ cashbackOn: true, pay: 0 })
  })
  it("entry, GHS 1 (cashback rounds to 0): cashback mode, pay face (no fee)", () => {
    expect(airtimePagePrice(1, mtn, 1.07)).toEqual({ cashbackOn: true, pay: 1 })
  })
  it("above Hubtel cap: legacy fee path like the server", () => {
    expect(airtimePagePrice(101, mtn, 108.07)).toEqual({ cashbackOn: false, pay: 108.07 })
  })
})

describe("display helpers", () => {
  const entry = { provider: "hubtel", rate: 3.96, share: 25 }

  it("matches the server quote for reference values", () => {
    const cfg = resolveCashbackConfig({
      enabled: true,
      surfaces: { dashboard: true },
      rates: { "airtime_mtn:hubtel": 3.96 },
      shares: { airtime: { customer: 25, dealer: 50, storefrontCustomer: 0, storefrontShop: 0 } },
    })
    for (const face of [1, 3, 10, 12.34, 50, 99.99]) {
      const s = quoteCashback({ serviceKey: "airtime_mtn", provider: "hubtel", faceAmount: face, buyer: "customer", channel: "dashboard" }, cfg)
      const d = quoteForDisplay(face, entry)
      expect(d.applied).toBe(s.applied)
      expect(d.pay).toBe(s.payAmount)
      expect(d.cashback).toBe(s.customerCashback)
    }
  })

  it("no entry, bad face or face above maxFace means not applied", () => {
    expect(quoteForDisplay(10, undefined)).toEqual({ pay: 10, cashback: 0, applied: false })
    expect(quoteForDisplay(0, entry).applied).toBe(false)
    expect(quoteForDisplay(150, { ...entry, maxFace: 100 })).toEqual({ pay: 150, cashback: 0, applied: false })
    expect(quoteForDisplay(100, { ...entry, maxFace: 100 }).applied).toBe(true)
  })

  it("priceLabel formats", () => {
    expect(priceLabel(3, { pay: 2.9, cashback: 0.1, applied: true })).toBe("GHS 2.90 (was GHS 3.00)")
    expect(priceLabel(3, { pay: 3, cashback: 0, applied: false })).toBe("GHS 3.00")
  })

  it("shortfall", () => {
    expect(shortfall(5, 10)).toBe(5)
    expect(shortfall(10, 10)).toBeNull()
    expect(shortfall(12, 10)).toBeNull()
    expect(shortfall(9.9, 10)).toBe(0.1)
  })
})

import {
  airtimeReceiveLabel, airtimeServiceKey, balanceLine, billReceiveLabel, bundleReceiveLabel, parsePriceChange, parseRates,
  priceParts, ratesStale,
} from "./display"

describe("checkout helpers", () => {
  it("ratesStale at 5 minutes", () => {
    expect(ratesStale(null, 0)).toBe(true)
    expect(ratesStale(1000, 1000 + 299_999)).toBe(false)
    expect(ratesStale(1000, 1000 + 300_000)).toBe(true)
  })
  it("parseRates is defensive", () => {
    expect(parseRates(null).applied).toBe(false)
    expect(parseRates({ services: { a: { provider: "hubtel", rate: 3, share: 25, maxFace: 100 }, b: { provider: 1 } } }).services)
      .toEqual({ a: { provider: "hubtel", rate: 3, share: 25, maxFace: 100 } })
  })
  it("airtimeServiceKey", () => {
    expect(airtimeServiceKey("Telecel")).toBe("airtime_telecel")
    expect(airtimeServiceKey("AT")).toBe("airtime_at")
  })
  it("parsePriceChange needs a 409 with a quote", () => {
    expect(parsePriceChange(409, { error: "x" })).toBeNull()
    expect(parsePriceChange(402, { quote: { payAmount: 1 } })).toBeNull()
    expect(parsePriceChange(409, { error: "Price updated", quote: { faceAmount: 10, payAmount: 9.91, customerCashback: 0.09 } }))
      .toEqual({ message: "Price updated", faceAmount: 10, payAmount: 9.91, customerCashback: 0.09 })
    expect(parsePriceChange(409, { quote: { faceAmount: 10, payAmount: 10 } })?.customerCashback).toBe(0)
  })
  it("priceParts and bundleReceiveLabel", () => {
    expect(priceParts(3, { pay: 2.9, cashback: 0.1, applied: true })).toEqual({ now: "GHS 2.90", was: "was GHS 3.00" })
    expect(priceParts(3, { pay: 3, cashback: 0, applied: false })).toEqual({ now: "GHS 3.00", was: null })
    expect(bundleReceiveLabel("Midnight Bundles", "8.48 GB")).toBe("Midnight Bundles · 8.48 GB")
    expect(bundleReceiveLabel(undefined, "8.48 GB")).toBe("8.48 GB")
    expect(bundleReceiveLabel("  ", "8.48 GB")).toBe("8.48 GB")
  })
  it("parsePriceChange keeps the airtime breakdown when the server sends it", () => {
    expect(parsePriceChange(409, { quote: { faceAmount: 10, payAmount: 10.5, customerCashback: 0, airtimeAmount: 10, feeAmount: 0.5, feeRate: 5 } }))
      .toMatchObject({ payAmount: 10.5, airtimeAmount: 10, feeAmount: 0.5, feeRate: 5 })
    const bare = parsePriceChange(409, { quote: { payAmount: 10, feeAmount: "x" } })
    expect(bare).not.toHaveProperty("feeAmount")
    expect(bare).not.toHaveProperty("airtimeAmount")
  })
  it("labels", () => {
    expect(airtimeReceiveLabel("MTN", 10)).toBe("GHS 10.00 MTN airtime")
    expect(billReceiveLabel("ECG", 50, "0123")).toBe("ECG GHS 50.00 to 0123")
    expect(balanceLine(0.9, 2.9)).toEqual({ text: "Balance GHS 0.90", short: "GHS 2.00 short" })
    expect(balanceLine(5, 2.9).short).toBeNull()
  })
})
