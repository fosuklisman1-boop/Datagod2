import { describe, it, expect, vi } from "vitest"
import { resolveCashbackConfig } from "./config"
import { airtimeCashbackTarget, quoteStorefrontAirtime, storefrontAirtimeOn, storefrontAirtimeTerms } from "./storefront-airtime"
import type { AirtimeProvider } from "../airtime-provider"

const RAW = {
  enabled: true,
  surfaces: { dashboard: false, storefront: true },
  rates: { "airtime_mtn:hubtel": 4, "airtime_mtn:digiwapy": 3, "airtime_telecel:hubtel": 4 },
  shares: { airtime: { customer: 0, dealer: 0, storefrontCustomer: 50, storefrontShop: 25 } },
  paymentFee: { airtime: 1.5 },
  storefrontGroups: { airtime: true },
}
const cfgWith = (patch: Record<string, unknown> = {}) => resolveCashbackConfig({ ...RAW, ...patch })

const deps = (provider: AirtimeProvider, digiwapyConfigured = true, cfg = cfgWith()) => ({
  getProvider: vi.fn(async () => provider),
  digiwapyConfigured: () => digiwapyConfigured,
  getConfig: vi.fn(async () => cfg),
})

describe("airtimeCashbackTarget", () => {
  it("hubtel: service key + Hubtel cap", async () => {
    expect(await airtimeCashbackTarget("MTN", 10, deps("hubtel"))).toEqual({ serviceKey: "airtime_mtn", provider: "hubtel", maxFace: 100 })
  })
  it("hubtel above its cap => null; at the cap => target", async () => {
    expect(await airtimeCashbackTarget("MTN", 100.01, deps("hubtel"))).toBeNull()
    expect(await airtimeCashbackTarget("MTN", 100, deps("hubtel"))).not.toBeNull()
  })
  it("digiwapy: uncapped when configured, null without env", async () => {
    expect(await airtimeCashbackTarget("AirtelTigo", 400, deps("digiwapy"))).toEqual({ serviceKey: "airtime_at", provider: "digiwapy", maxFace: null })
    expect(await airtimeCashbackTarget("MTN", 10, deps("digiwapy", false))).toBeNull()
  })
  it("manual or unknown network => null", async () => {
    expect(await airtimeCashbackTarget("MTN", 10, deps("manual"))).toBeNull()
    const d = deps("hubtel")
    expect(await airtimeCashbackTarget("Glo", 10, d)).toBeNull()
    expect(d.getProvider).not.toHaveBeenCalled()
  })
})

describe("storefrontAirtimeOn", () => {
  it("needs master switch, storefront surface and the airtime group", () => {
    expect(storefrontAirtimeOn(cfgWith())).toBe(true)
    expect(storefrontAirtimeOn(cfgWith({ enabled: false }))).toBe(false)
    expect(storefrontAirtimeOn(cfgWith({ surfaces: { storefront: false } }))).toBe(false)
    expect(storefrontAirtimeOn(cfgWith({ storefrontGroups: { airtime: false, bills: true } }))).toBe(false)
  })
})

describe("quoteStorefrontAirtime", () => {
  it("applied: face 10 at 4%, 50/25 split, 1.5% fee => pay 9.95", async () => {
    const q = await quoteStorefrontAirtime("MTN", 10, deps("hubtel"))
    expect(q).toMatchObject({
      applied: true, faceAmount: 10, rate: 4, share: 50, commission: 0.4,
      customerCashback: 0.2, shopShare: 0.1, base: 9.8, paymentFee: 0.15, feeRate: 1.5, payAmount: 9.95, provider: "hubtel",
    })
  })
  it("gate off => null without reading the provider", async () => {
    const d = deps("hubtel", true, cfgWith({ storefrontGroups: { airtime: false } }))
    expect(await quoteStorefrontAirtime("MTN", 10, d)).toBeNull()
    expect(d.getProvider).not.toHaveBeenCalled()
  })
  it("no rate for the provider => null", async () => {
    expect(await quoteStorefrontAirtime("AT", 10, deps("hubtel"))).toBeNull()
  })
  it("config read failure => null", async () => {
    const d = deps("hubtel")
    d.getConfig.mockRejectedValueOnce(new Error("boom"))
    expect(await quoteStorefrontAirtime("MTN", 10, d)).toBeNull()
  })
  it("provider read failure => null", async () => {
    const d = deps("hubtel")
    d.getProvider.mockRejectedValueOnce(new Error("boom"))
    expect(await quoteStorefrontAirtime("MTN", 10, d)).toBeNull()
  })
  it("hubtel face above cap => null", async () => {
    expect(await quoteStorefrontAirtime("MTN", 150, deps("hubtel"))).toBeNull()
  })
})

describe("storefrontAirtimeTerms", () => {
  it("applied network exposes rate/share/feeRate/maxFace only", async () => {
    const t = await storefrontAirtimeTerms("MTN", cfgWith(), deps("hubtel"))
    expect(t).toStrictEqual({ applied: true, rate: 4, share: 50, feeRate: 1.5, maxFace: 100 })
  })
  it("digiwapy is uncapped", async () => {
    expect((await storefrontAirtimeTerms("MTN", cfgWith(), deps("digiwapy"))).maxFace).toBeNull()
  })
  it("not applied (no rate / manual / gate off) => zeros", async () => {
    const zero = { applied: false, rate: 0, share: 0, feeRate: 0, maxFace: null }
    expect(await storefrontAirtimeTerms("AT", cfgWith(), deps("hubtel"))).toStrictEqual(zero)
    expect(await storefrontAirtimeTerms("MTN", cfgWith(), deps("manual"))).toStrictEqual(zero)
    expect(await storefrontAirtimeTerms("MTN", cfgWith({ enabled: false }), deps("hubtel"))).toStrictEqual(zero)
  })
  it("shop-only split (customer 0) is still applied with share 0", async () => {
    const cfg = cfgWith({ shares: { airtime: { customer: 0, dealer: 0, storefrontCustomer: 0, storefrontShop: 30 } } })
    expect(await storefrontAirtimeTerms("MTN", cfg, deps("hubtel"))).toStrictEqual({ applied: true, rate: 4, share: 0, feeRate: 1.5, maxFace: 100 })
  })
})
