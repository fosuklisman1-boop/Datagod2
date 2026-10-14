import { describe, it, expect } from "vitest"
import { resolveCashbackConfig } from "@/lib/cashback/config"
import {
  checkPendingCaps, getStorefrontOrderStatus, isValidOrderRef, loadAvailability, normaliseBuyer, parseAmount,
  parseExpectedPay, priceMatches, resolveShop, storefrontGroupOn, type AvailabilityDeps, type CapDeps,
} from "./shop"

const CFG = (over: Record<string, unknown> = {}) => resolveCashbackConfig({
  enabled: true,
  surfaces: { storefront: true },
  rates: { "bill_dstv:hubtel": 0.69, "data_mtn:hubtel": 3.96 },
  shares: {
    bills: { customer: 0, dealer: 0, storefrontCustomer: 20, storefrontShop: 40 },
    bundles: { customer: 0, dealer: 0, storefrontCustomer: 20, storefrontShop: 40 },
  },
  paymentFee: { bills: 1.95, bundles: 1.95 },
  storefrontGroups: { bills: true, bundles: true, airtime: false },
  ...over,
})

const BILLERS_AV = {
  enabled: true,
  billers: [
    { key: "dstv" as const, label: "DSTV", logo: "/billers/dstv.png", inputHint: "Smartcard number", page: "bills" as const, min: 5, max: 1000 },
    { key: "ecg" as const, label: "ECG", logo: "/billers/ecg.png", inputHint: "Meter number", page: "bills" as const, min: 5, max: 1000 },
  ],
}

function avDeps(over: Partial<AvailabilityDeps> = {}): AvailabilityDeps {
  return {
    getCashbackConfig: async () => CFG(),
    getHubtelConfig: async () => ({ enabled: true, paused: false, services: { bill_dstv: true, bill_ecg: false, data_mtn: true } }),
    getBillsAvailability: async () => structuredClone(BILLERS_AV),
    getBundlesAvailability: async () => ({ enabled: true, networks: [{ network: "MTN", label: "MTN" }] }),
    ...over,
  }
}

describe("storefrontGroupOn", () => {
  it("needs master, storefront surface and the group switch", () => {
    expect(storefrontGroupOn(CFG(), "bills")).toBe(true)
    expect(storefrontGroupOn(CFG({ enabled: false }), "bills")).toBe(false)
    expect(storefrontGroupOn(CFG({ surfaces: { storefront: false } }), "bills")).toBe(false)
    expect(storefrontGroupOn(CFG({ storefrontGroups: { bills: false } }), "bills")).toBe(false)
    expect(storefrontGroupOn(CFG(), "airtime")).toBe(false)
  })
})

describe("loadAvailability", () => {
  it("lists only billers whose Hubtel service is on, with shop-facing terms", async () => {
    const a = await loadAvailability(avDeps())
    expect(a.airtime).toBe(false)
    expect(a.bills.enabled).toBe(true)
    expect(a.bills.billers.map(b => b.key)).toEqual(["dstv"])
    expect(a.bills.billers[0].terms).toEqual({ applied: true, rate: 0.69, share: 20, feeRate: 1.95 })
    expect(a.bundles).toEqual({ enabled: true, networks: [{ network: "MTN", label: "MTN" }] })
    expect(JSON.stringify(a)).not.toContain("storefrontShop")
  })

  it("group switch off hides that group only", async () => {
    const a = await loadAvailability(avDeps({ getCashbackConfig: async () => CFG({ storefrontGroups: { bills: false, bundles: true } }) }))
    expect(a.bills).toEqual({ enabled: false, billers: [] })
    expect(a.bundles.enabled).toBe(true)
  })

  it("Phase 3a / 2b master off => group off", async () => {
    const a = await loadAvailability(avDeps({
      getBillsAvailability: async () => ({ enabled: false, billers: [] }),
      getBundlesAvailability: async () => ({ enabled: false, networks: [] }),
    }))
    expect(a.bills.enabled).toBe(false)
    expect(a.bundles.enabled).toBe(false)
  })

  it("Hubtel paused or disabled => nothing sold", async () => {
    for (const h of [{ enabled: true, paused: true }, { enabled: false, paused: false }]) {
      const a = await loadAvailability(avDeps({ getHubtelConfig: async () => ({ ...h, services: { bill_dstv: true, data_mtn: true } }) }))
      expect(a.bills.enabled).toBe(false)
      expect(a.bundles.enabled).toBe(false)
    }
  })

  it("config read failure => nothing available", async () => {
    const a = await loadAvailability(avDeps({ getCashbackConfig: async () => { throw new Error("x") } }))
    expect(a).toEqual({ airtime: false, bundles: { enabled: false, networks: [] }, bills: { enabled: false, billers: [] } })
  })

  it("gate on but no rate => listed, not applied, fee still shown", async () => {
    const a = await loadAvailability(avDeps({ getCashbackConfig: async () => CFG({ rates: {} }) }))
    expect(a.bills.billers[0].terms).toEqual({ applied: false, rate: 0, share: 0, feeRate: 1.95 })
  })
})

describe("request helpers", () => {
  it("normaliseBuyer requires email + Ghana phone, trims name", () => {
    expect(normaliseBuyer({ customerEmail: " A@B.co ", customerPhone: "+233 24 123 4567", customerName: "  Ama   K " }))
      .toEqual({ ok: true, buyer: { email: "a@b.co", phone: "0241234567", name: "Ama K" } })
    expect(normaliseBuyer({ customerEmail: "bad", customerPhone: "0241234567" }).ok).toBe(false)
    expect(normaliseBuyer({ customerEmail: "a@b.co", customerPhone: "12" }).ok).toBe(false)
    expect(normaliseBuyer({ customerEmail: "a@b.co", customerPhone: "0241234567", customerName: "x".repeat(101) }).ok).toBe(false)
    expect(normaliseBuyer({ customerEmail: "a@b.co", customerPhone: "0241234567" })).toMatchObject({ ok: true, buyer: { name: null } })
  })

  it("parseExpectedPay / parseAmount / priceMatches", () => {
    expect(parseExpectedPay(undefined)).toBeUndefined()
    expect(parseExpectedPay(null)).toBeUndefined()
    expect(parseExpectedPay(10.13)).toBe(10.13)
    expect(parseExpectedPay("10.13")).toBe(10.13)
    expect(parseExpectedPay("abc")).toBeNaN()
    expect(parseAmount("50")).toBe(50)
    expect(parseAmount("50.123")).toBeNaN()
    expect(parseAmount(true)).toBeNaN()
    expect(priceMatches(NaN, 1)).toBe(false)
    expect(priceMatches(10.13, 10.13)).toBe(true)
    expect(priceMatches(10.12, 10.13)).toBe(false)
  })

  it("isValidOrderRef", () => {
    expect(isValidOrderRef("BILL-0A1B2C3D4E5F")).toBe(true)
    expect(isValidOrderRef("x,shop_id.eq.y")).toBe(false)
    expect(isValidOrderRef(null)).toBe(false)
  })
})

describe("checkPendingCaps", () => {
  const keys = { email: "a@b.co", phone: "0241234567", shopId: "shop-1" }
  const deps = (over: Partial<CapDeps> = {}, log: string[] = []): CapDeps => ({
    limit: async (name, _m, _w, id) => (log.push(`${name}|${id}`), true),
    countPending: async () => 0,
    now: () => 1_700_000_000_000,
    ...over,
  })

  it("passes and uses per-kind limiter keys", async () => {
    const log: string[] = []
    expect(await checkPendingCaps(deps({}, log), "bill", "hubtel_bill_orders", keys)).toBeNull()
    expect(log.sort()).toEqual([
      "shop_bill_cap_email|e:a@b.co", "shop_bill_cap_phone|p:0241234567",
      "shop_bill_cap_shop_1h|s:shop-1", "shop_bill_cap_shop_5m|s:shop-1",
    ])
  })

  it("limiter denial => 429", async () => {
    const r = await checkPendingCaps(deps({ limit: async n => !n.endsWith("_email") }), "bill", "hubtel_bill_orders", keys)
    expect(r).toMatchObject({ status: 429, error: expect.stringContaining("pending orders") })
    const s = await checkPendingCaps(deps({ limit: async n => !n.endsWith("_5m") }), "bundle", "hubtel_data_orders", keys)
    expect(s).toMatchObject({ status: 429, error: expect.stringContaining("this shop") })
  })

  it("DB backup counts => 429 at the airtime thresholds", async () => {
    const at = (col: string, n: number) => deps({ countPending: async (_t, c) => (c === col ? n : 0) })
    expect(await checkPendingCaps(at("buyer_email", 5), "bill", "hubtel_bill_orders", keys)).toMatchObject({ status: 429 })
    expect(await checkPendingCaps(at("buyer_phone", 4), "bill", "hubtel_bill_orders", keys)).toBeNull()
    expect(await checkPendingCaps(at("shop_id", 15), "bill", "hubtel_bill_orders", keys)).toMatchObject({ status: 429 })
  })
})

describe("db helpers", () => {
  const fakeDb = (rows: Record<string, any[]>, calls: any[] = []) => ({
    from(table: string) {
      const f: Record<string, unknown> = {}
      const c: any = {
        select: () => c, limit: () => c,
        or: (s: string) => (calls.push({ table, or: s }), c),
        eq: (k: string, v: unknown) => ((f[k] = v), c),
        maybeSingle: async () => {
          const hit = (rows[table] ?? []).find(r => Object.entries(f).every(([k, v]) => r[k] === v))
          return { data: hit ?? null, error: null }
        },
        then: (res: any, rej: any) =>
          Promise.resolve({ data: (rows[table] ?? []).filter(r => Object.entries(f).every(([k, v]) => r[k] === v)), error: null }).then(res, rej),
      }
      return c
    },
  }) as any

  it("resolveShop: active shops only, sanitised handle", async () => {
    const calls: any[] = []
    const db = fakeDb({ user_shops: [{ id: "s1", is_active: true }, { id: "s2", is_active: false }] }, calls)
    expect(await resolveShop(db, "My-Shop")).toEqual({ id: "s1" })
    expect(calls[0].or).toBe("subdomain.eq.my-shop,shop_slug.eq.my-shop")
    expect(await resolveShop(db, "")).toBeNull()
    expect(await resolveShop(db, 42)).toBeNull()
    expect(await resolveShop(fakeDb({ user_shops: [{ id: "s2", is_active: false }] }), "x")).toBeNull()
  })

  it("resolveShop: a handle matching two active shops is ambiguous => null", async () => {
    const db = fakeDb({ user_shops: [{ id: "s1", is_active: true }, { id: "s3", is_active: true }] })
    expect(await resolveShop(db, "clash")).toBeNull()
  })

  it("getStorefrontOrderStatus: this shop's storefront rows only, status fields only", async () => {
    const db = fakeDb({
      hubtel_bill_orders: [{ reference_code: "BILL-1", shop_id: "s1", channel: "storefront", status: "pending", payment_status: "unpaid", amount: 5 }],
      hubtel_data_orders: [{ reference_code: "SB-1", shop_id: "s1", channel: "storefront", status: "completed", payment_status: "paid" }],
    })
    expect(await getStorefrontOrderStatus(db, "s1", "BILL-1")).toEqual({ status: "pending", paymentStatus: "unpaid" })
    expect(await getStorefrontOrderStatus(db, "s1", "SB-1")).toEqual({ status: "completed", paymentStatus: "paid" })
    expect(await getStorefrontOrderStatus(db, "s2", "SB-1")).toBeNull()
  })

  it("getStorefrontOrderStatus: by order id, still this shop's storefront rows and status fields only", async () => {
    const id = "11111111-1111-4111-8111-111111111111"
    const db = fakeDb({
      hubtel_bill_orders: [],
      hubtel_data_orders: [{ id, reference_code: "SB-1", shop_id: "s1", channel: "storefront", status: "pending", payment_status: "paid", paid_amount: 5 }],
    })
    expect(await getStorefrontOrderStatus(db, "s1", { orderId: id })).toEqual({ status: "pending", paymentStatus: "paid" })
    expect(await getStorefrontOrderStatus(db, "s2", { orderId: id })).toBeNull()
  })
})
