import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  roles: [] as any[],
  rates: [] as any[],
  failRoles: false,
  failRates: false,
  reads: [] as string[],
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      h.reads.push(table)
      let key: string | null = null
      const b: any = {
        select: () => b,
        eq: (_c: string, v: string) => { key = v; return b },
        in: () => b,
        limit: () => b,
        single: async () => ({ data: key !== null && key in h.settings ? { value: h.settings[key] } : null, error: null }),
        then: (res: any, rej: any) =>
          Promise.resolve(
            table === "roles"
              ? h.failRoles ? { data: null, error: { message: "boom" } } : { data: h.roles, error: null }
              : h.failRates ? { data: null, error: { message: "boom" } } : { data: h.rates, error: null }
          ).then(res, rej),
      }
      return b
    },
  }),
}))

import { airtimeBaseFeeRate, airtimeFeeRateFor } from "./airtime-pricing"
import { RoleReadError } from "./roles/repo"

const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-gold", slug: "gold", rank: 20, is_system: false, archived_at: null },
]

beforeEach(() => {
  h.settings = { airtime_fee_mtn_dealer: { rate: 2 }, airtime_fee_mtn_customer: { rate: 4 } }
  h.roles = ROLES
  h.rates = []
  h.failRoles = false
  h.failRates = false
  h.reads = []
})

describe("airtimeFeeRateFor", () => {
  it("dealer and user slugs read exactly today's keys and never touch roles", async () => {
    expect(await airtimeFeeRateFor("MTN", "dealer")).toBe(2)
    expect(await airtimeFeeRateFor("MTN", "user")).toBe(4)
    expect(h.reads).not.toContain("roles")
    expect(h.reads).not.toContain("role_service_rates")
  })

  it("a missing legacy key still defaults to 5 for both system slugs", async () => {
    h.settings = {}
    expect(await airtimeFeeRateFor("Telecel", "dealer")).toBe(5)
    expect(await airtimeFeeRateFor("Telecel", "user")).toBe(5)
  })

  it("a system slug is not affected by a roles read failure", async () => {
    h.failRoles = true
    expect(await airtimeFeeRateFor("MTN", "dealer")).toBe(2)
    expect(await airtimeFeeRateFor("MTN", "user")).toBe(4)
  })

  it("a custom role with a row uses it", async () => {
    h.rates = [{ role_id: "r-gold", service_key: "airtime_fee:mtn", value: 1.5 }]
    expect(await airtimeFeeRateFor("MTN", "gold")).toBe(1.5)
  })

  it("a custom role without a row falls to the dealer legacy value", async () => {
    expect(await airtimeFeeRateFor("MTN", "gold")).toBe(2)
  })

  it("AT and AirtelTigo use the 'at' key", async () => {
    h.settings = { airtime_fee_at_dealer: { rate: 3 }, airtime_fee_at_customer: { rate: 6 } }
    h.rates = [{ role_id: "r-gold", service_key: "airtime_fee:at", value: 0.5 }]
    expect(await airtimeFeeRateFor("AT", "gold")).toBe(0.5)
    expect(await airtimeFeeRateFor("AT", "dealer")).toBe(3)
  })

  it("a custom role read failure rejects with RoleReadError (never a silent legacy rate)", async () => {
    h.failRoles = true
    await expect(airtimeFeeRateFor("MTN", "gold")).rejects.toBeInstanceOf(RoleReadError)
    h.failRoles = false
    h.failRates = true
    await expect(airtimeFeeRateFor("MTN", "gold")).rejects.toBeInstanceOf(RoleReadError)
  })
})

describe("airtimeBaseFeeRate wrapper", () => {
  it("is the dealer/user slug rate", async () => {
    expect(await airtimeBaseFeeRate("MTN", true)).toBe(2)
    expect(await airtimeBaseFeeRate("MTN", false)).toBe(4)
  })
})
