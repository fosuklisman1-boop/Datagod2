import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    settings: {} as Record<string, any>,
    role: "user" as string,
    dealerRatesEnabled: true as boolean | undefined,
    hasShop: true,
    authed: true,
    usersError: false,
    roles: [] as any[],
    roleRates: [] as any[],
    rolesError: false,
    tablesRead: [] as string[],
  }
  const chain = (table: string) => {
    const filters: Record<string, any> = {}
    const c: any = {}
    c.select = () => c
    c.in = () => c
    c.limit = () => c
    c.eq = (col: string, v: any) => ((filters[col] = v), c)
    c.single = async () => ({ data: { value: state.settings[filters.key] ?? null }, error: null })
    c.maybeSingle = async () => {
      if (table === "users") return state.usersError ? { data: null, error: { message: "boom" } } : { data: { role: state.role }, error: null }
      if (table === "user_shops") return { data: state.hasShop ? { dealer_rates_enabled: state.dealerRatesEnabled } : null, error: null }
      return { data: null, error: null }
    }
    c.then = (res: any, rej: any) =>
      Promise.resolve(
        state.rolesError
          ? { data: null, error: { message: "boom" } }
          : { data: table === "roles" ? state.roles : state.roleRates, error: null }
      ).then(res, rej)
    return c
  }
  const fake = {
    auth: { getUser: async () => (state.authed ? { data: { user: { id: "u-1" } }, error: null } : { data: { user: null }, error: { message: "x" } }) },
    from: (t: string) => (state.tablesRead.push(t), chain(t)),
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

import { GET } from "./route"

const get = (auth: string | null = "Bearer t") =>
  GET(new Request("http://x/api/airtime/my-rates", { headers: auth ? { authorization: auth } : {} }) as any)

const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-gold", slug: "gold", rank: 20, is_system: false, archived_at: null },
]

beforeEach(() => {
  h.state.settings = {
    airtime_fee_mtn_customer: { rate: 5 }, airtime_fee_mtn_dealer: { rate: 3 },
    airtime_fee_telecel_customer: { rate: 6 }, airtime_fee_telecel_dealer: { rate: 4 },
    airtime_fee_at_customer: { rate: 7 }, airtime_fee_at_dealer: { rate: 2 },
  }
  h.state.role = "user"
  h.state.dealerRatesEnabled = true
  h.state.hasShop = true
  h.state.authed = true
  h.state.usersError = false
  h.state.roles = []
  h.state.roleRates = []
  h.state.rolesError = false
  h.state.tablesRead = []
})

const CUSTOMER = { mtn: 5, telecel: 6, at: 7 }
const DEALER = { mtn: 3, telecel: 4, at: 2 }

describe("GET /api/airtime/my-rates (rule A)", () => {
  it("401 without a Bearer token or with a bad token", async () => {
    expect((await get(null)).status).toBe(401)
    h.state.authed = false
    expect((await get()).status).toBe(401)
  })

  it("is no-store and returns the caller's own tier rates with no roles read", async () => {
    const res = await get()
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect((await res.json()).rates).toEqual(CUSTOMER)
    h.state.role = "dealer"
    expect((await (await get()).json()).rates).toEqual(DEALER)
    h.state.role = "admin"
    expect((await (await get()).json()).rates).toEqual(CUSTOMER)
    expect(h.state.tablesRead).not.toContain("roles")
  })

  it("sub_agent follows dealer_rates_enabled; no shop is a customer", async () => {
    h.state.role = "sub_agent"
    expect((await (await get()).json()).rates).toEqual(DEALER)
    h.state.dealerRatesEnabled = false
    expect((await (await get()).json()).rates).toEqual(CUSTOMER)
    h.state.hasShop = false
    expect((await (await get()).json()).rates).toEqual(CUSTOMER)
  })

  it("a custom role uses its rows; a roles read failure falls back to the legacy customer rates", async () => {
    h.state.role = "gold"; h.state.roles = ROLES
    h.state.roleRates = [{ role_id: "r-gold", service_key: "airtime_fee:mtn", value: 1 }]
    expect((await (await get()).json()).rates).toEqual({ mtn: 1, telecel: 4, at: 2 })
    h.state.rolesError = true
    expect((await (await get()).json()).rates).toEqual(CUSTOMER)
  })

  it("a user read failure is a 503 (the page keeps its own computation)", async () => {
    h.state.usersError = true
    expect((await get()).status).toBe(503)
  })
})
