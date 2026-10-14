import { describe, expect, it } from "vitest"
import { resolveCashbackConfig, type CashbackConfig } from "./config"
import { quoteCashback, quoteStorefront, samePrice, toPesewas, type QuoteInput } from "./quote"

const cfg = (mut: (c: CashbackConfig) => void = () => {}): CashbackConfig => {
  const c = resolveCashbackConfig({
    enabled: true,
    surfaces: { dashboard: true, bots: true, storefront: true, api: true },
    rates: { "airtime_mtn:hubtel": 3.96, "bill_ecg:hubtel": 1.708 },
    shares: {
      airtime: { customer: 25, dealer: 50, storefrontCustomer: 20, storefrontShop: 40 },
      bundles: { customer: 0, dealer: 0, storefrontCustomer: 0, storefrontShop: 0 },
      bills: { customer: 25, dealer: 50, storefrontCustomer: 20, storefrontShop: 40 },
    },
  })
  mut(c)
  return c
}
const inp = (o: Partial<QuoteInput> = {}): QuoteInput => ({
  serviceKey: "airtime_mtn", provider: "hubtel", faceAmount: 10, buyer: "customer", channel: "dashboard", ...o,
})

describe("quoteCashback", () => {
  it("reference values: customer 25 / dealer 50", () => {
    const a = quoteCashback(inp(), cfg())
    expect(a).toMatchObject({ applied: true, rate: 3.96, share: 25, customerCashback: 0.09, shopShare: 0, payAmount: 9.91, commission: 0.396, datagodKeeps: 0.306, provider: "hubtel" })
    const d = quoteCashback(inp({ buyer: "dealer" }), cfg())
    expect(d).toMatchObject({ customerCashback: 0.19, payAmount: 9.81, share: 50 })
  })
  it("storefront split 0.07 + 0.15", () => {
    const q = quoteCashback(inp({ channel: "storefront", shop: true }), cfg())
    expect(q).toMatchObject({ applied: true, share: 20, customerCashback: 0.07, shopShare: 0.15, payAmount: 9.93, datagodKeeps: 0.176 })
  })
  it("storefront shop-only split (customer 0) is applied: customer pays face, shop earns its share", () => {
    const q = quoteCashback(inp({ channel: "storefront", shop: true }), cfg(c => { c.shares.airtime.storefrontCustomer = 0 }))
    expect(q).toMatchObject({ applied: true, customerCashback: 0, shopShare: 0.15, payAmount: 10 })
  })
  it("shop flag on another channel also uses storefront split", () => {
    expect(quoteCashback(inp({ channel: "bots", shop: true }), cfg()).shopShare).toBe(0.15)
  })
  it("override share", () => {
    const q = quoteCashback(inp(), cfg((c) => { c.shares.overrides = { airtime_mtn: { customer: 50 } } }))
    expect(q.customerCashback).toBe(0.19)
  })
  it("bill service with 3-dp rate", () => {
    const q = quoteCashback(inp({ serviceKey: "bill_ecg", faceAmount: 100 }), cfg())
    expect(q.customerCashback).toBe(0.42) // 100*1.708*25/100 = 42.7 pesewas -> 42
  })
  const notApplied = (q: ReturnType<typeof quoteCashback>, face = 10) =>
    expect(q).toMatchObject({ applied: false, customerCashback: 0, shopShare: 0, share: 0, payAmount: face })
  it("not applied: master off", () => notApplied(quoteCashback(inp(), cfg((c) => { c.enabled = false }))))
  it("not applied: surface off", () => notApplied(quoteCashback(inp(), cfg((c) => { c.surfaces.dashboard = false }))))
  it("not applied: manual provider", () => notApplied(quoteCashback(inp({ provider: "manual" }), cfg())))
  it("not applied: no group", () => notApplied(quoteCashback(inp({ serviceKey: "other_x" }), cfg())))
  it("not applied: rate 0 / missing", () => {
    notApplied(quoteCashback(inp(), cfg((c) => { c.rates = {} })))
    notApplied(quoteCashback(inp({ provider: "digiwapy" }), cfg()))
  })
  it("not applied: relevant share 0", () => {
    notApplied(quoteCashback(inp({ serviceKey: "airtime_mtn" }), cfg((c) => { c.shares.airtime.customer = 0 })))
    notApplied(quoteCashback(inp({ buyer: "dealer" }), cfg((c) => { c.shares.airtime.dealer = 0 })))
  })
  it("eligible but cashback floors to 0 (GHS 1 at 3.96% x 25%) is still applied: pay face, no fee", () => {
    const q = quoteCashback(inp({ faceAmount: 1 }), cfg())
    expect(q).toMatchObject({ applied: true, customerCashback: 0, shopShare: 0, payAmount: 1, share: 25, rate: 3.96 })
    expect(q.datagodKeeps).toBe(0.0396)
  })
  it("face 0.01 with high rate floors to 0: applied at face", () => {
    const q = quoteCashback(inp({ faceAmount: 0.01 }), cfg((c) => { c.rates["airtime_mtn:hubtel"] = 20; c.shares.airtime.customer = 100 }))
    expect(q).toMatchObject({ applied: true, customerCashback: 0, payAmount: 0.01 })
  })
  it("floating edge: face 1.15, rate 3.96, share 50 -> 2 pesewas", () => {
    const q = quoteCashback(inp({ faceAmount: 1.15, buyer: "dealer" }), cfg())
    expect(q.customerCashback).toBe(0.02)
    expect(q.payAmount).toBe(1.13)
  })
  it("never exceeds commission when shares sum over 100", () => {
    const q = quoteCashback(inp({ channel: "storefront" }), cfg((c) => { c.shares.airtime.storefrontCustomer = 100; c.shares.airtime.storefrontShop = 100 }))
    expect(q.applied).toBe(false)
  })
  it("rejects non-positive / non-finite face", () => {
    expect(quoteCashback(inp({ faceAmount: 0 }), cfg()).applied).toBe(false)
    expect(quoteCashback(inp({ faceAmount: NaN }), cfg()).applied).toBe(false)
  })
})

describe("pesewa helpers", () => {
  it("toPesewas", () => { expect(toPesewas(1.15)).toBe(115); expect(toPesewas(0.07)).toBe(7) })
  it("samePrice", () => {
    expect(samePrice(9.91, 9.91)).toBe(true)
    expect(samePrice(0.1 + 0.2, 0.3)).toBe(true)
    expect(samePrice(9.91, 9.92)).toBe(false)
  })
})

describe("quoteStorefront", () => {
  const sf = (fee: number, on = true) => cfg(c => {
    c.paymentFee = { airtime: fee, bundles: 0, bills: fee }
    c.storefrontGroups = { airtime: on, bundles: false, bills: on }
    c.rates["bill_dstv:hubtel"] = 0.69
  })
  const { channel: _c, shop: _s, ...base } = inp()
  it("airtime GHS 10 with fee 1.95: base 9.93, fee 0.20, pay 10.13", () => {
    const q = quoteStorefront(base, sf(1.95))
    expect(q).toMatchObject({ applied: true, base: 9.93, paymentFee: 0.2, feeRate: 1.95, payAmount: 10.13, shopShare: 0.15 })
  })
  it("fee 0 pays the base", () => {
    expect(quoteStorefront(base, sf(0))).toMatchObject({ base: 9.93, paymentFee: 0, payAmount: 9.93 })
  })
  it("DSTV GHS 100: fee rounds up 194.75p to 195", () => {
    const q = quoteStorefront({ ...base, serviceKey: "bill_dstv", faceAmount: 100 }, sf(1.95))
    expect(q).toMatchObject({ customerCashback: 0.13, shopShare: 0.27, base: 99.87, paymentFee: 1.95, payAmount: 101.82 })
  })
  it("group switch off: not applied, no fee", () => {
    const q = quoteStorefront(base, sf(1.95, false))
    expect(q).toMatchObject({ applied: false, base: 10, paymentFee: 0, payAmount: 10 })
  })
  it("surface off: not applied, no fee", () => {
    const q = quoteStorefront(base, cfg(c => { Object.assign(c, sf(1.95)); c.surfaces.storefront = false }))
    expect(q).toMatchObject({ applied: false, paymentFee: 0, payAmount: 10 })
  })
})
