import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    settings: {} as Record<string, any>,
    role: "user" as string | null,
    authed: true,
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
    c.single = async () => {
      if (table === "users") return { data: state.role ? { role: state.role } : null, error: null }
      return { data: { value: state.settings[filters.key] ?? null }, error: null }
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

const get = () => GET(new Request("http://x/api/shop/airtime/constraints", { headers: { authorization: "Bearer t" } }) as any)

const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-gold", slug: "gold", rank: 20, is_system: false, archived_at: null },
]

beforeEach(() => {
  h.state.settings = {
    airtime_fee_mtn_customer: { rate: 5 }, airtime_fee_mtn_dealer: { rate: 3 },
    airtime_fee_telecel_customer: { rate: 6 }, airtime_fee_telecel_dealer: { rate: 4 },
  }
  h.state.role = "user"
  h.state.authed = true
  h.state.roles = []
  h.state.roleRates = []
  h.state.rolesError = false
  h.state.tablesRead = []
})

describe("shop airtime constraints (rule E: dealer OR admin; sub_agent is a customer)", () => {
  it("401 when not authenticated", async () => {
    h.state.authed = false
    expect((await get()).status).toBe(401)
  })

  it("max markup = 10 - base: dealer and admin use the dealer rate, user and sub_agent the customer rate; no roles read", async () => {
    const mtn = async () => (await (await get()).json()).maxMarkups
    h.state.role = "dealer"; expect(await mtn()).toEqual({ mtn: 7, telecel: 6, at: 5 })
    h.state.role = "admin"; expect(await mtn()).toEqual({ mtn: 7, telecel: 6, at: 5 })
    h.state.role = "user"; expect(await mtn()).toEqual({ mtn: 5, telecel: 4, at: 5 })
    h.state.role = "sub_agent"; expect(await mtn()).toEqual({ mtn: 5, telecel: 4, at: 5 })
    expect(h.state.tablesRead).not.toContain("roles")
  })

  it("a custom role uses its row; a read failure shows the legacy customer rate", async () => {
    h.state.role = "gold"; h.state.roles = ROLES
    h.state.roleRates = [{ role_id: "r-gold", service_key: "airtime_fee:mtn", value: 1 }]
    expect((await (await get()).json()).maxMarkups.mtn).toBe(9)
    h.state.rolesError = true
    expect((await (await get()).json()).maxMarkups.mtn).toBe(5)
  })
})
