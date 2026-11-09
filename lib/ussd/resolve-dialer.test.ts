import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  user: { id: "u1", role: "sub_agent", email: "a@b.c" } as any,
  shop: { data: { dealer_rates_enabled: true }, error: null } as { data: any; error: any },
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (t: string) => {
      if (t === "users") {
        // resolveDialer looks up by phone_number; getDealerRateTier by id. Both end in maybeSingle.
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.user ? { ...h.user } : null, error: null }) }) }) }
      }
      if (t === "wallets") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { balance: 5 }, error: null }) }) }) }
      if (t === "user_shops") return { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => h.shop }) }) }) }
      throw new Error(`Unexpected table ${t}`)
    },
  }),
}))

import { resolveDialer } from "./resolve-dialer"

beforeEach(() => {
  h.user = { id: "u1", role: "sub_agent", email: "a@b.c" }
  h.shop = { data: { dealer_rates_enabled: true }, error: null }
})

describe("resolveDialer rateTier", () => {
  it("sub_agent with dealer rates on => dealer", async () => {
    expect((await resolveDialer("0244123456")).rateTier).toBe("dealer")
  })
  it("sub_agent with dealer rates off => customer", async () => {
    h.shop = { data: { dealer_rates_enabled: false }, error: null }
    expect((await resolveDialer("0244123456")).rateTier).toBe("customer")
  })
  it("sub_agent whose shop read fails => customer (fails closed)", async () => {
    h.shop = { data: null, error: { code: "57014", message: "timeout" } }
    expect((await resolveDialer("0244123456")).rateTier).toBe("customer")
  })
  it("sub_agent with no shop row => customer", async () => {
    h.shop = { data: null, error: null }
    expect((await resolveDialer("0244123456")).rateTier).toBe("customer")
  })
  it("sub_agent when the column is not deployed yet => dealer, as today", async () => {
    h.shop = { data: null, error: { code: "42703", message: "no column" } }
    expect((await resolveDialer("0244123456")).rateTier).toBe("dealer")
  })
  it("dealer => dealer without needing a shop; user => customer", async () => {
    h.shop = { data: { dealer_rates_enabled: false }, error: null }
    h.user = { id: "u2", role: "dealer" }
    expect((await resolveDialer("0244123456")).rateTier).toBe("dealer")
    h.user = { id: "u3", role: "user" }
    expect((await resolveDialer("0244123456")).rateTier).toBe("customer")
  })
  it("unregistered number => no dialer info", async () => {
    h.user = null
    expect(await resolveDialer("0244123456")).toEqual({})
  })
})
