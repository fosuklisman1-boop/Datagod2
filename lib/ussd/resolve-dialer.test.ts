import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  user: { id: "u1", role: "sub_agent", email: "a@b.c" } as any,
  shop: { data: { dealer_rates_enabled: true }, error: null } as { data: any; error: any },
  rolesReads: 0,
  roles: { data: [
    { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
    { id: "r-gold", slug: "gold", rank: 20, is_system: false, archived_at: null },
  ], error: null } as { data: any; error: any },
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
      if (t === "roles") {
        h.rolesReads++
        return { select: () => ({ limit: async () => h.roles }) }
      }
      throw new Error(`Unexpected table ${t}`)
    },
  }),
}))

import { resolveDialer } from "./resolve-dialer"

beforeEach(() => {
  h.user = { id: "u1", role: "sub_agent", email: "a@b.c" }
  h.shop = { data: { dealer_rates_enabled: true }, error: null }
  h.rolesReads = 0
  h.roles = { data: [
    { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
    { id: "r-gold", slug: "gold", rank: 20, is_system: false, archived_at: null },
  ], error: null }
})

describe("resolveDialer rateRole", () => {
  it("system roles resolve to dealer/user by tier with no roles read", async () => {
    h.user = { id: "u1", role: "sub_agent" }
    expect((await resolveDialer("0244123456")).rateRole).toBe("dealer")
    h.shop = { data: { dealer_rates_enabled: false }, error: null }
    expect((await resolveDialer("0244123456")).rateRole).toBe("user")
    h.shop = { data: null, error: null }
    expect((await resolveDialer("0244123456")).rateRole).toBe("user")
    h.user = { id: "u2", role: "dealer" }
    expect((await resolveDialer("0244123456")).rateRole).toBe("dealer")
    h.user = { id: "u3", role: "admin" }
    expect((await resolveDialer("0244123456")).rateRole).toBe("user")
    h.user = { id: "u4", role: "user" }
    expect((await resolveDialer("0244123456")).rateRole).toBe("user")
    h.user = { id: "u5", role: null }
    expect((await resolveDialer("0244123456")).rateRole).toBe("user")
    expect(h.rolesReads).toBe(0)
  })
  it("a live custom role keeps its own slug", async () => {
    h.user = { id: "u6", role: "gold" }
    expect((await resolveDialer("0244123456")).rateRole).toBe("gold")
  })
  it("a custom role whose roles read fails keeps its slug so the rate lookup fails closed", async () => {
    h.user = { id: "u6", role: "gold" }
    h.roles = { data: null, error: { message: "boom" } }
    expect((await resolveDialer("0244123456")).rateRole).toBe("gold")
  })
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
