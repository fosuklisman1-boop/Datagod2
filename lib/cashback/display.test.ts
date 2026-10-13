import { describe, expect, it } from "vitest"
import { resolveCashbackConfig } from "./config"
import { quoteCashback } from "./quote"
import { priceLabel, quoteForDisplay, shortfall } from "./display"

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
