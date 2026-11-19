import { describe, expect, it } from "vitest"
import { resolveCashbackConfig } from "./config"
import { buildCashbackRates } from "./rates"
import { buyerQuoteInputFor } from "./buyer-share"
import { getBuyerQuoteInput } from "../bills/runtime"
import { catalogBuyer, priceCatalog } from "../api-v1/bundles"

const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-gold", slug: "gold", rank: 20, is_system: false, archived_at: null },
  { id: "r-sub", slug: "sub_agent", rank: null, is_system: true, archived_at: null },
]
const cfg = resolveCashbackConfig({
  enabled: true,
  surfaces: { dashboard: true, api: true },
  rates: { "data_mtn:hubtel": 4, "bill_ecg:hubtel": 4, "airtime_mtn:hubtel": 4 },
  shares: {
    bundles: { customer: 10, dealer: 40, storefrontCustomer: 0, storefrontShop: 0 },
    bills: { customer: 10, dealer: 40, storefrontCustomer: 0, storefrontShop: 0 },
    airtime: { customer: 10, dealer: 40, storefrontCustomer: 0, storefrontShop: 0 },
    overrides: { data_mtn: { dealer: 55 } },
  },
})

/** users.role read, optional user_shops row, roles + role_service_rates. Counts every table read. */
function fakeDb(o: { role: string | null; rows?: any[]; usersError?: boolean; rolesError?: boolean; shopEnabled?: boolean }) {
  const reads: string[] = []
  const db: any = {
    from(table: string) {
      reads.push(table)
      if (table === "users") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => o.usersError ? { data: null, error: { message: "x" } } : { data: o.role === null ? null : { role: o.role }, error: null } }) }) }
      }
      if (table === "user_shops") {
        return { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { dealer_rates_enabled: o.shopEnabled ?? true }, error: null }) }) }) }) }
      }
      const b: any = {
        select: () => b, limit: () => b, in: () => b,
        then: (res: any, rej: any) =>
          Promise.resolve(o.rolesError ? { data: null, error: { message: "x" } } : { data: table === "roles" ? ROLES : (o.rows ?? []), error: null }).then(res, rej),
      }
      return b
    },
  }
  return { db, reads }
}

describe("getBuyerQuoteInput (bills / standard bundles runtime)", () => {
  it("dealer/customer/sub_agent/admin: tier only, one users read, no roles or rates read", async () => {
    for (const [role, buyer] of [["dealer", "dealer"], ["user", "customer"], ["admin", "customer"], [null, "customer"], ["sub_agent", "dealer"]] as const) {
      const { db, reads } = fakeDb({ role })
      expect(await getBuyerQuoteInput(db, "u1", "data_mtn", cfg)).toEqual({ buyer })
      expect(reads.filter((t) => t === "users")).toHaveLength(1)
      expect(reads).not.toContain("roles")
      expect(reads).not.toContain("role_service_rates")
    }
  })
  it("sub_agent with dealer rates off is customer", async () => {
    expect(await getBuyerQuoteInput(fakeDb({ role: "sub_agent", shopEnabled: false }).db, "u1", "bill_ecg", cfg)).toEqual({ buyer: "customer" })
  })
  it("system role read failure throws exactly like getBuyerTier (caller: not applied)", async () => {
    await expect(getBuyerQuoteInput(fakeDb({ role: "user", usersError: true }).db, "u1", "data_mtn", cfg)).rejects.toBeTruthy()
  })
  it("custom role: service row > group row > legacy, on bills and bundles keys", async () => {
    const rows = [
      { role_id: "r-gold", service_key: "cashback_share:bills", value: 22 },
      { role_id: "r-gold", service_key: "cashback_share:data_mtn", value: 33 },
    ]
    expect(await getBuyerQuoteInput(fakeDb({ role: "gold", rows }).db, "u1", "data_mtn", cfg)).toEqual({ buyer: "customer", buyerShare: 33 })
    expect(await getBuyerQuoteInput(fakeDb({ role: "gold", rows }).db, "u1", "bill_ecg", cfg)).toEqual({ buyer: "customer", buyerShare: 22 })
    expect(await getBuyerQuoteInput(fakeDb({ role: "gold", rows: [] }).db, "u1", "data_mtn", cfg)).toEqual({ buyer: "customer", buyerShare: 10 })
  })
  it("custom role roles-read failure throws (not applied)", async () => {
    await expect(getBuyerQuoteInput(fakeDb({ role: "gold", rolesError: true }).db, "u1", "data_mtn", cfg)).rejects.toBeTruthy()
  })
})

describe("buyerQuoteInputFor", () => {
  it("falls back to getBuyerTier when the deps have no role-aware input", async () => {
    expect(await buyerQuoteInputFor({ getBuyerTier: async () => "dealer" }, "u", "data_mtn", cfg)).toEqual({ buyer: "dealer" })
  })
  it("prefers getBuyerQuoteInput and never calls getBuyerTier", async () => {
    let tierCalls = 0
    const r = await buyerQuoteInputFor(
      { getBuyerTier: async () => (tierCalls++, "customer"), getBuyerQuoteInput: async () => ({ buyer: "customer", buyerShare: 7 }) }, "u", "data_mtn", cfg)
    expect(r).toEqual({ buyer: "customer", buyerShare: 7 })
    expect(tierCalls).toBe(0)
  })
})

describe("API bundle catalog price (v1 + v2)", () => {
  const cat = [{ name: "c", bundles: [{ token: "t", display: "1GB", amount: 100 }] }]
  const pay = (buyer: "customer" | "dealer", share?: number) => priceCatalog("MTN", cat, cfg, buyer, share)[0].bundles[0]
  it("dealer/customer identical to today incl. per-service override", () => {
    expect(pay("customer").customer_cashback).toBe(0.4)
    expect(pay("dealer").customer_cashback).toBe(2.2)
  })
  it("a custom share replaces the tier share", () => {
    expect(pay("customer", 50).customer_cashback).toBe(2)
  })
  it("catalogBuyer: tier-only deps, custom share, and failure => customer with no share", async () => {
    expect(await catalogBuyer({ getBuyerTier: async () => "dealer" }, "u", "MTN", cfg)).toEqual({ buyer: "dealer" })
    expect(await catalogBuyer({ getBuyerTier: async () => "customer", getBuyerQuoteInput: async () => ({ buyer: "customer", buyerShare: 9 }) }, "u", "MTN", cfg))
      .toEqual({ buyer: "customer", buyerShare: 9 })
    expect(await catalogBuyer({ getBuyerTier: async () => { throw new Error("x") } }, "u", "MTN", cfg)).toEqual({ buyer: "customer" })
  })
})

describe("buildCashbackRates (display)", () => {
  const prov = async () => "hubtel" as const
  it("no resolver: today's tier shares", async () => {
    const r = await buildCashbackRates(cfg, "dealer", prov, false)
    expect(r.services.data_mtn?.share).toBe(55)
    expect(r.services.bill_ecg?.share).toBe(40)
  })
  it("resolver share is displayed and used; undefined falls back to the tier share", async () => {
    const r = await buildCashbackRates(cfg, "customer", prov, false, async (k) => (k === "data_mtn" ? 70 : undefined))
    expect(r.services.data_mtn?.share).toBe(70)
    expect(r.services.bill_ecg?.share).toBe(10)
  })
  it("resolver failure propagates (route shows no rates)", async () => {
    await expect(buildCashbackRates(cfg, "customer", prov, false, async () => { throw new Error("x") })).rejects.toBeTruthy()
  })
})
