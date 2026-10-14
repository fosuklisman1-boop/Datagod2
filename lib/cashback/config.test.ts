import { describe, expect, it, vi } from "vitest"
import {
  CASHBACK_CONFIG_KEY, effectiveShares, getCashbackConfig, groupOf, resolveCashbackConfig, setCashbackConfig,
  validateCashbackPatch,
} from "./config"

const base = () => resolveCashbackConfig(null)
const gs = (o: Record<string, number> = {}) => ({ customer: 0, dealer: 0, storefrontCustomer: 0, storefrontShop: 0, ...o })

describe("cashback config resolve", () => {
  it("key", () => expect(CASHBACK_CONFIG_KEY).toBe("commission_cashback_config"))
  it("defaults all off / 0", () => {
    const c = base()
    expect(c.enabled).toBe(false)
    expect(c.surfaces).toEqual({ dashboard: false, bots: false, storefront: false, api: false })
    expect(c.rates).toEqual({})
    expect(c.shares.airtime).toEqual(gs())
    expect(c.shares.bundles).toEqual(gs())
    expect(c.shares.bills).toEqual(gs())
    expect(c.shares.overrides).toEqual({})
    expect(resolveCashbackConfig("garbage")).toEqual(c)
  })
  it("only literal true enables", () => {
    const c = resolveCashbackConfig({ enabled: "true", surfaces: { dashboard: 1, bots: true, api: "yes" } })
    expect(c.enabled).toBe(false)
    expect(c.surfaces).toEqual({ dashboard: false, bots: true, storefront: false, api: false })
    expect(resolveCashbackConfig({ enabled: true }).enabled).toBe(true)
  })
  it("invalid numbers become 0, unknown keys dropped", () => {
    const c = resolveCashbackConfig({
      rates: { "airtime_mtn:hubtel": "3", "bill_ecg:hubtel": 1.708, "nope:hubtel": 1, "airtime_mtn:other": 1, "airtime_mtn:digiwapy": 50 },
      shares: { airtime: { customer: 101, dealer: NaN, storefrontCustomer: 20.123, storefrontShop: 5 }, overrides: { airtime_mtn: { customer: 9, bogus: 1 }, nope: { customer: 1 } } },
    })
    expect(c.rates).toEqual({ "airtime_mtn:hubtel": 0, "bill_ecg:hubtel": 1.708, "airtime_mtn:digiwapy": 0 })
    expect(c.shares.airtime).toEqual(gs({ storefrontShop: 5 }))
    expect(c.shares.overrides).toEqual({ airtime_mtn: { customer: 9 } })
  })
})

describe("groupOf / effectiveShares", () => {
  it("maps prefixes", () => {
    expect(groupOf("airtime_mtn")).toBe("airtime")
    expect(groupOf("data_at")).toBe("bundles")
    expect(groupOf("bill_ecg")).toBe("bills")
    expect(groupOf("other")).toBeNull()
  })
  it("override takes precedence over group", () => {
    const c = base()
    c.shares.airtime = gs({ customer: 25, dealer: 50 })
    c.shares.overrides = { airtime_mtn: { customer: 10 } }
    expect(effectiveShares(c, "airtime_mtn")).toEqual(gs({ customer: 10, dealer: 50 }))
    expect(effectiveShares(c, "airtime_at")).toEqual(gs({ customer: 25, dealer: 50 }))
    expect(effectiveShares(c, "unknown")).toEqual(gs())
  })
})

describe("validateCashbackPatch", () => {
  const cur = base()
  const bad = (body: unknown, current = cur) => {
    const r = validateCashbackPatch(body, current)
    expect(r.ok).toBe(false)
    return r.ok ? "" : r.error
  }

  it("accepts the spec example", () => {
    const body = {
      enabled: true,
      surfaces: { dashboard: true },
      rates: { "airtime_mtn:hubtel": 3.96, "bill_ecg:hubtel": 1.708 },
      shares: { airtime: gs({ customer: 25, dealer: 50, storefrontCustomer: 20, storefrontShop: 40 }) },
    }
    const r = validateCashbackPatch(body, cur)
    expect(r).toEqual({ ok: true, patch: body })
  })
  it("rejects non-object, unknown field, bad types", () => {
    bad(null); bad([]); bad({ foo: 1 }); bad({ enabled: "yes" }); bad({ surfaces: { nope: true } }); bad({ surfaces: { api: 1 } })
  })
  it("rejects enabling bots; allows storefront and api; turning them off is fine", () => {
    expect(bad({ surfaces: { bots: true } })).toMatch(/surfaces\.bots cannot be enabled yet/)
    expect(bad({ surfaces: { dashboard: true, bots: true } })).toMatch(/dashboard, storefront and api/)
    expect(validateCashbackPatch({ surfaces: { dashboard: true, storefront: true } }, cur).ok).toBe(true)
    expect(validateCashbackPatch({ surfaces: { api: true } }, cur)).toEqual({ ok: true, patch: { surfaces: { api: true } } })
    expect(validateCashbackPatch({ surfaces: { dashboard: true, storefront: true, api: true } }, cur).ok).toBe(true)
    const r = validateCashbackPatch({ surfaces: { dashboard: true, bots: false, storefront: false, api: false } }, cur)
    expect(r.ok).toBe(true)
  })
  it("resolves paymentFee / storefrontGroups defaults and validates patches", () => {
    const c = base()
    expect(c.paymentFee).toEqual({ airtime: 0, bundles: 0, bills: 0 })
    expect(c.storefrontGroups).toEqual({ airtime: false, bundles: false, bills: false })
    expect(resolveCashbackConfig({ paymentFee: { bills: 1.95, airtime: 11 }, storefrontGroups: { bills: true, airtime: "x" } }))
      .toMatchObject({ paymentFee: { airtime: 0, bills: 1.95 }, storefrontGroups: { bills: true, airtime: false } })
    bad({ paymentFee: { bills: 10.5 } }); bad({ paymentFee: { bills: 1.955 } }); bad({ paymentFee: { nope: 1 } })
    bad({ paymentFee: { bills: -1 } }); bad({ storefrontGroups: { bills: 1 } }); bad({ storefrontGroups: { nope: true } })
    const ok = validateCashbackPatch({ paymentFee: { bills: 10, airtime: 1.95 }, storefrontGroups: { bills: true } }, cur)
    expect(ok.ok).toBe(true)
  })
  it("setCashbackConfig sends fully merged paymentFee / storefrontGroups", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null })
    const current = resolveCashbackConfig({ paymentFee: { airtime: 1 }, storefrontGroups: { airtime: true } })
    await setCashbackConfig({ rpc } as any, { paymentFee: { bills: 2 }, storefrontGroups: { bills: true } }, current)
    expect(rpc).toHaveBeenCalledWith("commission_cashback_config_patch", {
      p_patch: { paymentFee: { airtime: 1, bundles: 0, bills: 2 }, storefrontGroups: { airtime: true, bundles: false, bills: true } },
    })
  })
  it("rejects share 101 and bad share decimals", () => {
    bad({ shares: { airtime: gs({ customer: 101 }) } })
    bad({ shares: { airtime: gs({ customer: 10.123 }) } })
    bad({ shares: { airtime: { customer: 1 } } }) // incomplete group
  })
  it("rejects storefront sum 101 at group level", () => {
    bad({ shares: { airtime: gs({ storefrontCustomer: 60, storefrontShop: 41 }) } })
  })
  it("rejects storefront sum 101 via override, against the current group", () => {
    const c = base()
    c.shares.airtime = gs({ storefrontCustomer: 60, storefrontShop: 30 })
    bad({ shares: { overrides: { airtime_mtn: { storefrontShop: 41 } } } }, c)
    expect(validateCashbackPatch({ shares: { overrides: { airtime_mtn: { storefrontShop: 40 } } } }, c).ok).toBe(true)
  })
  it("rejects a group patch that breaks an existing override", () => {
    const c = base()
    c.shares.overrides = { airtime_mtn: { storefrontShop: 50 } }
    bad({ shares: { airtime: gs({ storefrontCustomer: 60 }) } }, c)
  })
  it("rejects bad rates", () => {
    bad({ rates: { "airtime_mtn:hubtel": 20.5 } })
    bad({ rates: { "airtime_mtn:hubtel": 1.2345 } })
    bad({ rates: { "airtime_mtn:hubtel": -1 } })
    bad({ rates: { "airtime_mtn:hubtel": "3" } })
    expect(validateCashbackPatch({ rates: { "airtime_mtn:hubtel": 20 } }, cur).ok).toBe(true)
  })
  it("rejects unknown service key and unknown provider", () => {
    bad({ rates: { "airtime_nope:hubtel": 1 } })
    bad({ rates: { "airtime_mtn:paystack": 1 } })
    bad({ shares: { overrides: { airtime_nope: { customer: 1 } } } })
  })
})

describe("db helpers", () => {
  it("get resolves value; set calls the RPC", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { value: { enabled: true } }, error: null })
    const db: any = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
      rpc: vi.fn().mockResolvedValue({ data: { enabled: true, rates: { "bill_ecg:hubtel": 1.7 } }, error: null }),
    }
    expect((await getCashbackConfig(db)).enabled).toBe(true)
    const out = await setCashbackConfig(db, { enabled: true }, resolveCashbackConfig({}))
    expect(db.rpc).toHaveBeenCalledWith("commission_cashback_config_patch", { p_patch: { enabled: true } })
    expect(out.rates["bill_ecg:hubtel"]).toBe(1.7)
  })
  it("set sends fully merged shares so an override patch never wipes other overrides or groups", async () => {
    const db: any = { rpc: vi.fn().mockResolvedValue({ data: {}, error: null }) }
    const current = resolveCashbackConfig({ shares: {
      airtime: { customer: 25, dealer: 50, storefrontCustomer: 20, storefrontShop: 40 },
      overrides: { bill_ecg: { customer: 10 }, airtime_mtn: { dealer: 60 } },
    } })
    await setCashbackConfig(db, { shares: { overrides: { bill_ecg: { dealer: 15 } } } } as any, current)
    const sent = db.rpc.mock.calls[0][1].p_patch
    expect(sent.shares.overrides).toEqual({ bill_ecg: { customer: 10, dealer: 15 }, airtime_mtn: { dealer: 60 } })
    expect(sent.shares.airtime).toEqual({ customer: 25, dealer: 50, storefrontCustomer: 20, storefrontShop: 40 })
  })
  it("get throws on error", async () => {
    const db: any = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: new Error("x") }) }) }) }) }
    await expect(getCashbackConfig(db)).rejects.toThrow("x")
  })
})
