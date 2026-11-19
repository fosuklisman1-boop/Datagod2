import { describe, expect, it } from "vitest"
import { resolveCashbackConfig } from "./config"
import { quoteCashback } from "./quote"
import { cashbackShareKeys, resolveBuyerShare } from "./buyer-share"
import { RoleReadError } from "../roles/repo"

const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-gold", slug: "gold", rank: 20, is_system: false, archived_at: null },
]

const cfg = resolveCashbackConfig({
  enabled: true,
  surfaces: { dashboard: true, api: true, storefront: true, bots: true },
  rates: { "data_mtn:hubtel": 4, "bill_ecg:hubtel": 4, "airtime_mtn:hubtel": 4 },
  shares: {
    bundles: { customer: 10, dealer: 40, storefrontCustomer: 10, storefrontShop: 10 },
    bills: { customer: 10, dealer: 40, storefrontCustomer: 10, storefrontShop: 10 },
    airtime: { customer: 10, dealer: 40, storefrontCustomer: 10, storefrontShop: 10, },
    overrides: { data_mtn: { dealer: 55 } },
  },
})

function fakeDb(rows: Array<{ role_id: string; service_key: string; value: number }>, fail = false) {
  const tables: string[] = []
  const db = {
    from(table: string) {
      tables.push(table)
      const b: any = {
        select: () => b, limit: () => b, in: () => b,
        then: (res: any, rej: any) =>
          Promise.resolve(
            fail ? { data: null, error: { message: "x" } } : { data: table === "roles" ? ROLES : rows, error: null }
          ).then(res, rej),
      }
      return b
    },
  }
  return { db, tables }
}

describe("cashbackShareKeys", () => {
  it("normalises the service key and names the group", () => {
    expect(cashbackShareKeys("data_mtn")).toEqual({ service: "cashback_share:data_mtn", group: "cashback_share:bundles" })
    expect(cashbackShareKeys("bill_ECG-x")).toEqual({ service: "cashback_share:bill_ecg_x", group: "cashback_share:bills" })
  })
})

describe("resolveBuyerShare", () => {
  it("system slugs: undefined, no reads at all", async () => {
    const { db, tables } = fakeDb([])
    expect(await resolveBuyerShare(db, "dealer", "data_mtn", cfg, true)).toBeUndefined()
    expect(await resolveBuyerShare(db, "user", "data_mtn", cfg, false)).toBeUndefined()
    expect(tables).toEqual([])
  })
  it("custom role, no rows: legacy effective share by tier (incl. per-service override)", async () => {
    const { db } = fakeDb([])
    expect(await resolveBuyerShare(db, "gold", "data_mtn", cfg, true)).toBe(55)
    expect(await resolveBuyerShare(db, "gold", "data_mtn", cfg, false)).toBe(10)
    expect(await resolveBuyerShare(db, "gold", "bill_ecg", cfg, true)).toBe(40)
  })
  it("group row beats legacy; service row beats group row", async () => {
    const g = fakeDb([{ role_id: "r-gold", service_key: "cashback_share:bundles", value: 25 }])
    expect(await resolveBuyerShare(g.db, "gold", "data_mtn", cfg, true)).toBe(25)
    const s = fakeDb([
      { role_id: "r-gold", service_key: "cashback_share:bundles", value: 25 },
      { role_id: "r-gold", service_key: "cashback_share:data_mtn", value: 33 },
    ])
    expect(await resolveBuyerShare(s.db, "gold", "data_mtn", cfg, true)).toBe(33)
  })
  it("a zero row is a real value", async () => {
    const { db } = fakeDb([{ role_id: "r-gold", service_key: "cashback_share:data_mtn", value: 0 }])
    expect(await resolveBuyerShare(db, "gold", "data_mtn", cfg, true)).toBe(0)
  })
  it("read failure throws", async () => {
    await expect(resolveBuyerShare(fakeDb([], true).db, "gold", "data_mtn", cfg, true)).rejects.toBeInstanceOf(RoleReadError)
  })
  it("unknown service group: undefined", async () => {
    const { db } = fakeDb([])
    expect(await resolveBuyerShare(db, "gold", "nope", cfg, true)).toBeUndefined()
  })
})

describe("quoteCashback buyerShare", () => {
  const inp = (over: object = {}) => ({ serviceKey: "data_mtn", provider: "hubtel" as const, faceAmount: 100, buyer: "customer" as const, channel: "dashboard" as const, ...over })
  it("uses buyerShare instead of the tier share", () => {
    expect(quoteCashback(inp({ buyerShare: 50 }), cfg).share).toBe(50)
    expect(quoteCashback(inp(), cfg).share).toBe(10)
  })
  it("buyerShare 0 is not applied", () => {
    expect(quoteCashback(inp({ buyerShare: 0 }), cfg).applied).toBe(false)
  })
  it("storefront ignores buyerShare", () => {
    expect(quoteCashback(inp({ channel: "storefront", shop: true, buyerShare: 90 }), cfg).share).toBe(10)
  })
})
