import { describe, it, expect } from "vitest"
import { buildLiveFacts, FALLBACK_FACTS, formatCedis, networkOf, type RawFacts } from "./live-facts"
import { resolveBillsConfig } from "@/lib/bills/config"
import { PRODUCTS } from "./products"

function raw(over: Partial<RawFacts> = {}): RawFacts {
  return {
    packages: [],
    airtimeEnabled: { MTN: true, Telecel: true, AT: true },
    airtimeMin: 1,
    afaPrice: 50,
    bills: resolveBillsConfig({
      enabled: true,
      billers: {
        ecg: { enabled: true, min: 5, max: 1000 },
        ghana_water: { enabled: true, min: 5, max: 1000 },
        dstv: { enabled: true, min: 5, max: 1000 },
        gotv: { enabled: true, min: 5, max: 1000 },
        startimes: { enabled: true, min: 5, max: 1000 },
        telecel_broadband: { enabled: true, min: 5, max: 1000 },
      },
    }),
    results: [
      { board: "WASSCE", enabled: true, price: 20 },
      { board: "BECE", enabled: true, price: 15 },
      { board: "NOVDEC", enabled: true, price: 22 },
    ],
    smsPricePerCredit: 0.04,
    apiV2Enabled: true,
    ussd: { main: "*920#", shop: "*920*SHOPCODE#" },
    ...over,
  }
}

describe("networkOf", () => {
  it("maps every network string used for packages", () => {
    expect(networkOf("MTN")).toBe("MTN")
    expect(networkOf("mtn")).toBe("MTN")
    expect(networkOf("Telecel")).toBe("Telecel")
    expect(networkOf("AT-iShare")).toBe("AT")
    expect(networkOf("AT - BigTime")).toBe("AT")
    expect(networkOf("AT - ISHARE")).toBe("AT")
    expect(networkOf("AirtelTigo")).toBe("AT")
    expect(networkOf("iShare")).toBe("AT")
    expect(networkOf("Vodafone")).toBeNull()
    expect(networkOf("")).toBeNull()
  })
})

describe("buildLiveFacts — data", () => {
  it("takes the lowest available, positive price per network", () => {
    const f = buildLiveFacts(raw({
      packages: [
        { network: "MTN", price: 5, is_available: true },
        { network: "MTN", price: 3.5, is_available: true },
        { network: "MTN", price: 2, is_available: false },
      ],
    }))
    expect(f.products["mtn-data"]).toMatchObject({ available: true, fromPrice: 3.5 })
  })

  it("marks a network unavailable when all its packages are off", () => {
    const f = buildLiveFacts(raw({
      packages: [
        { network: "Telecel", price: 4, is_available: false },
        { network: "Telecel", price: 6, is_available: null },
      ],
    }))
    expect(f.products["telecel-data"].available).toBe(false)
    expect(f.products["telecel-data"].fromPrice).toBeNull()
  })

  it("ignores null, non-numeric and zero prices (no NaN, no 0)", () => {
    const f = buildLiveFacts(raw({
      packages: [
        { network: "AT-iShare", price: null, is_available: true },
        { network: "AT-iShare", price: "abc", is_available: true },
        { network: "AT - BigTime", price: 0, is_available: true },
        { network: "AT - BigTime", price: "4.20", is_available: true },
      ],
    }))
    expect(f.products["at-data"]).toMatchObject({ available: true, fromPrice: 4.2 })
  })

  it("only null/abc rows → unavailable", () => {
    const f = buildLiveFacts(raw({
      packages: [
        { network: "MTN", price: null, is_available: true },
        { network: "MTN", price: "abc", is_available: true },
      ],
    }))
    expect(f.products["mtn-data"].available).toBe(false)
    expect(f.products["mtn-data"].fromPrice).toBeNull()
  })
})

describe("buildLiveFacts — other products", () => {
  it("airtime lists enabled networks with the minimum amount", () => {
    const f = buildLiveFacts(raw({ airtimeEnabled: { MTN: true, Telecel: false, AT: true }, airtimeMin: 2 }))
    expect(f.products.airtime).toEqual({ available: true, fromPrice: 2, parts: ["MTN", "AT"] })
    const off = buildLiveFacts(raw({ airtimeEnabled: { MTN: false, Telecel: false, AT: false } }))
    expect(off.products.airtime.available).toBe(false)
  })

  it("afaPrice null → afa unavailable", () => {
    const f = buildLiveFacts(raw({ afaPrice: null }))
    expect(f.products["afa-registration"].available).toBe(false)
    expect(buildLiveFacts(raw({ afaPrice: 45 })).products["afa-registration"]).toMatchObject({ available: true, fromPrice: 45 })
  })

  it("bills disabled → hub and every biller unavailable", () => {
    const base = raw()
    const f = buildLiveFacts(raw({ bills: { ...base.bills!, enabled: false } }))
    for (const k of ["utility-bills", "ecg-prepaid", "ghana-water", "pay-dstv", "pay-gotv", "startimes", "telecel-broadband"] as const) {
      expect(f.products[k].available, k).toBe(false)
    }
    const none = buildLiveFacts(raw({ bills: null }))
    expect(none.products["utility-bills"].available).toBe(false)
  })

  it("bills on with only DSTV → only pay-dstv and the hub", () => {
    const f = buildLiveFacts(raw({ bills: resolveBillsConfig({ enabled: true, billers: { dstv: { enabled: true, min: 5, max: 100 } } }) }))
    expect(f.products["pay-dstv"].available).toBe(true)
    expect(f.products["ecg-prepaid"].available).toBe(false)
    expect(f.products["utility-bills"].available).toBe(true)
    expect(f.products["utility-bills"].parts).toEqual(["DSTV"])
    expect(f.products["utility-bills"].fromPrice).toBeNull()
    expect(f.products["pay-dstv"].fromPrice).toBeNull()
  })

  it("results: disabled board is excluded from parts and price", () => {
    const f = buildLiveFacts(raw({
      results: [
        { board: "WASSCE", enabled: true, price: 20 },
        { board: "BECE", enabled: false, price: 10 },
        { board: "NOVDEC", enabled: true, price: 18 },
      ],
    }))
    expect(f.products["results-checker"]).toEqual({ available: true, fromPrice: 18, parts: ["WASSCE", "NOVDEC"] })
    const off = buildLiveFacts(raw({ results: [{ board: "WASSCE", enabled: true, price: null }] }))
    expect(off.products["results-checker"].available).toBe(false)
  })

  it("bulk-sms always available with per-credit price", () => {
    expect(buildLiveFacts(raw({ smsPricePerCredit: 0.025 })).products["bulk-sms"]).toMatchObject({ available: true, fromPrice: 0.025 })
    expect(buildLiveFacts(raw({ smsPricePerCredit: null })).products["bulk-sms"]).toMatchObject({ available: true, fromPrice: null })
  })

  it("ussd.main null → ussd unavailable", () => {
    const f = buildLiveFacts(raw({ ussd: { main: null, shop: "*920*SHOPCODE#" } }))
    expect(f.products.ussd.available).toBe(false)
    expect(f.ussd).toEqual({ main: null, shop: "*920*SHOPCODE#" })
    expect(buildLiveFacts(raw()).products.ussd.available).toBe(true)
  })

  it("apiV2Enabled false → developers unavailable", () => {
    expect(buildLiveFacts(raw({ apiV2Enabled: false })).products.developers.available).toBe(false)
    expect(buildLiveFacts(raw()).products.developers.available).toBe(true)
  })

  it("join and whatsapp are always available", () => {
    const f = buildLiveFacts(raw({ apiV2Enabled: false, bills: null, afaPrice: null }))
    expect(f.products.join.available).toBe(true)
    expect(f.products.whatsapp.available).toBe(true)
  })

  it("returns facts for every registry key", () => {
    const f = buildLiveFacts(raw())
    for (const p of PRODUCTS) expect(f.products[p.key], p.key).toBeDefined()
  })
})

describe("FALLBACK_FACTS", () => {
  it("is all available except ussd, with every price null and no ussd codes", () => {
    for (const p of PRODUCTS) {
      expect(FALLBACK_FACTS.products[p.key].available, p.key).toBe(p.key !== "ussd")
      expect(FALLBACK_FACTS.products[p.key].fromPrice, p.key).toBeNull()
    }
    expect(FALLBACK_FACTS.ussd).toEqual({ main: null, shop: null })
  })
})

describe("formatCedis", () => {
  it("formats amounts >= 1 with 2 decimals", () => {
    expect(formatCedis(3.5)).toBe("GH₵3.50")
    expect(formatCedis(12)).toBe("GH₵12.00")
  })
  it("keeps up to 3 decimals below 1, trimming but keeping at least 2", () => {
    expect(formatCedis(0.025)).toBe("GH₵0.025")
    expect(formatCedis(0.5)).toBe("GH₵0.50")
    expect(formatCedis(0.04)).toBe("GH₵0.04")
  })
})
