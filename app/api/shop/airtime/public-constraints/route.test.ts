import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    settings: {} as Record<string, any>,
    cashbackReadError: false,
    providers: { MTN: "hubtel", Telecel: "manual", AT: "digiwapy" } as Record<string, string>,
    merchantRole: "user",
    roles: [] as any[],
    roleRates: [] as any[],
    rolesError: false,
    tablesRead: [] as string[],
  }
  const chain = (table: string) => {
    const filters: Record<string, any> = {}
    const c: any = {}
    for (const m of ["select", "or"]) c[m] = () => c
    c.eq = (col: string, v: any) => ((filters[col] = v), c)
    c.single = async () => {
      if (table === "user_shops") return { data: { id: "shop-1", user_id: "m-1", airtime_markup_mtn: "2" }, error: null }
      if (table === "users") return { data: { role: state.merchantRole }, error: null }
      return { data: { value: state.settings[filters.key] ?? null }, error: null }
    }
    c.maybeSingle = async () => {
      if (filters.key === "commission_cashback_config" && state.cashbackReadError) return { data: null, error: { message: "x" } }
      const v = state.settings[filters.key]
      return { data: v === undefined ? null : { value: v }, error: null }
    }
    c.in = () => c
    c.limit = () => c
    c.then = (res: any, rej: any) =>
      Promise.resolve(
        state.rolesError
          ? { data: null, error: { message: "boom" } }
          : { data: table === "roles" ? state.roles : state.roleRates, error: null }
      ).then(res, rej)
    return c
  }
  return { state, fake: { from: (t: string) => (state.tablesRead.push(t), chain(t)) } }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/airtime-service", () => ({
  airtimeProviderDeps: {
    getProvider: async (n: string) => h.state.providers[n],
    digiwapyConfigured: () => true,
  },
}))

import { GET } from "./route"

const CASHBACK_ON = {
  enabled: true,
  surfaces: { storefront: true },
  rates: { "airtime_mtn:hubtel": 4, "airtime_at:digiwapy": 3, "airtime_telecel:hubtel": 4 },
  shares: { airtime: { customer: 10, dealer: 20, storefrontCustomer: 50, storefrontShop: 25 } },
  paymentFee: { airtime: 1.5 },
  storefrontGroups: { airtime: true },
}

const get = () => GET(new Request("http://x/api/shop/airtime/public-constraints?slug=myshop&network=MTN") as any)

const LEGACY_BODY = {
  success: true,
  baseFeePercent: 5,
  markupPercent: 2,
  totalFeePercent: 7,
  isAvailable: true,
  allAvailability: { MTN: true, Telecel: true, AT: true },
}

beforeEach(() => {
  h.state.settings = { airtime_fee_mtn_customer: { rate: 5 } }
  h.state.cashbackReadError = false
  h.state.merchantRole = "user"
  h.state.roles = []
  h.state.roleRates = []
  h.state.rolesError = false
  h.state.tablesRead = []
})

describe("public-constraints base fee resolves per owner role (rule D)", () => {
  const ROLES = [
    { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
    { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
    { id: "r-gold", slug: "gold", rank: 20, is_system: false, archived_at: null },
  ]
  const base = async () => (await (await get()).json()).baseFeePercent

  it("dealer 3, user 5, admin owner is a customer (5); no roles read", async () => {
    h.state.settings.airtime_fee_mtn_dealer = { rate: 3 }
    h.state.merchantRole = "dealer"; expect(await base()).toBe(3)
    h.state.merchantRole = "user"; expect(await base()).toBe(5)
    h.state.merchantRole = "admin"; expect(await base()).toBe(5)
    expect(h.state.tablesRead).not.toContain("roles")
  })

  it("custom-role owner uses its row; a read failure falls back to the legacy customer rate", async () => {
    h.state.merchantRole = "gold"; h.state.roles = ROLES
    h.state.roleRates = [{ role_id: "r-gold", service_key: "airtime_fee:mtn", value: 1 }]
    expect(await base()).toBe(1)
    h.state.rolesError = true
    expect(await base()).toBe(5)
  })
})

describe("public-constraints cashback terms", () => {
  it("gate off / no config / read error => response unchanged (no cashback key)", async () => {
    expect(JSON.stringify(await (await get()).json())).toBe(JSON.stringify(LEGACY_BODY))
    h.state.settings.commission_cashback_config = { ...CASHBACK_ON, storefrontGroups: { airtime: false } }
    expect(JSON.stringify(await (await get()).json())).toBe(JSON.stringify(LEGACY_BODY))
    h.state.settings.commission_cashback_config = CASHBACK_ON
    h.state.cashbackReadError = true
    expect(JSON.stringify(await (await get()).json())).toBe(JSON.stringify(LEGACY_BODY))
  })

  it("gate on => per-network shop-facing terms only", async () => {
    h.state.settings.commission_cashback_config = CASHBACK_ON
    const body = await (await get()).json()
    expect(body).toStrictEqual({
      ...LEGACY_BODY,
      cashback: {
        MTN: { applied: true, rate: 4, share: 50, feeRate: 1.5, maxFace: 100 },
        Telecel: { applied: false, rate: 0, share: 0, feeRate: 0, maxFace: null },
        AT: { applied: true, rate: 3, share: 50, feeRate: 1.5, maxFace: null },
      },
    })
    expect(JSON.stringify(body)).not.toMatch(/storefrontShop|shopShare|commission|dealer/)
  })
})
