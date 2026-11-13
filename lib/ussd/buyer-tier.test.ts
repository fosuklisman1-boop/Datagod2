// lib/ussd/buyer-tier.test.ts
import { describe, it, expect } from "vitest"
import { resolveBuyerTier } from "./buyer-tier"

function fakeSupabase(tables: Record<string, unknown>) {
  const reads: string[] = []
  const lookups: Array<{ table: string; col: string; val: unknown }> = []
  const client: any = {
    from: (table: string) => {
      reads.push(table)
      const data = () => (tables[table] === undefined ? null : tables[table])
      const b: any = {
        select: () => b, is: () => b, not: () => b,
        eq: (col: string, val: unknown) => { lookups.push({ table, col, val }); return b },
        single: () => Promise.resolve({ data: data(), error: null }),
        maybeSingle: () => Promise.resolve({ data: data(), error: null }),
      }
      return b
    },
  }
  return { client, reads, lookups }
}

const settings = { ussd_price_tier: "regular" }

describe("resolveBuyerTier", () => {
  it("no account: settings tier, no user fields", async () => {
    const { client } = fakeSupabase({ users: null, app_settings: settings })
    expect(await resolveBuyerTier(client, "+233200000101", "Telecel")).toEqual({
      effectivePriceTier: "regular", subAgentParentShopId: undefined, userId: undefined,
      walletBalance: undefined, mtnWhitelistActive: false,
    })
  })

  it("no account and no settings row: regular", async () => {
    const { client } = fakeSupabase({ users: null, app_settings: null })
    expect((await resolveBuyerTier(client, "+233200000101", "Telecel")).effectivePriceTier).toBe("regular")
  })

  it("no account keeps a non-default settings tier", async () => {
    const { client } = fakeSupabase({ users: null, app_settings: { ussd_price_tier: "dealer" } })
    expect((await resolveBuyerTier(client, "+233200000101", "Telecel")).effectivePriceTier).toBe("dealer")
  })

  it("dealer with wallet", async () => {
    const { client } = fakeSupabase({ users: { id: "u1", role: "dealer" }, app_settings: settings, wallets: { balance: "42.5" } })
    expect(await resolveBuyerTier(client, "+233200000101", "Telecel")).toEqual({
      effectivePriceTier: "dealer", subAgentParentShopId: undefined, userId: "u1",
      walletBalance: 42.5, mtnWhitelistActive: false,
    })
  })

  it("dealer without wallet row", async () => {
    const { client } = fakeSupabase({ users: { id: "u1", role: "dealer" }, app_settings: settings, wallets: null })
    expect((await resolveBuyerTier(client, "+233200000101", "Telecel")).walletBalance).toBeUndefined()
  })

  it("sub_agent with parent shop", async () => {
    const { client } = fakeSupabase({
      users: { id: "u2", role: "sub_agent" }, app_settings: settings,
      user_shops: { parent_shop_id: "shop-9" }, wallets: { balance: 7 },
    })
    expect(await resolveBuyerTier(client, "+233200000101", "Telecel")).toEqual({
      effectivePriceTier: "sub_agent", subAgentParentShopId: "shop-9", userId: "u2",
      walletBalance: 7, mtnWhitelistActive: false,
    })
  })

  it("sub_agent without parent shop is regular", async () => {
    const { client } = fakeSupabase({
      users: { id: "u2", role: "sub_agent" }, app_settings: { ussd_price_tier: "dealer" },
      user_shops: null, wallets: { balance: 3 },
    })
    expect(await resolveBuyerTier(client, "+233200000101", "Telecel")).toEqual({
      effectivePriceTier: "regular", subAgentParentShopId: undefined, userId: "u2",
      walletBalance: 3, mtnWhitelistActive: false,
    })
  })

  it("customer role is regular even when settings tier differs", async () => {
    const { client } = fakeSupabase({ users: { id: "u3", role: "customer" }, app_settings: { ussd_price_tier: "dealer" }, wallets: { balance: 1 } })
    expect(await resolveBuyerTier(client, "+233200000101", "Telecel")).toEqual({
      effectivePriceTier: "regular", subAgentParentShopId: undefined, userId: "u3",
      walletBalance: 1, mtnWhitelistActive: false,
    })
  })

  it("MTN with xpress is whitelist-active and reads admin_settings", async () => {
    const { client, reads } = fakeSupabase({ users: null, app_settings: settings, admin_settings: { value: { provider: "xpress" } } })
    expect((await resolveBuyerTier(client, "+233200000101", "MTN")).mtnWhitelistActive).toBe(true)
    expect(reads).toContain("admin_settings")
  })

  it("MTN with datakazina is not whitelist-active", async () => {
    const { client } = fakeSupabase({ users: null, app_settings: settings, admin_settings: { value: { provider: "datakazina" } } })
    expect((await resolveBuyerTier(client, "+233200000101", "MTN")).mtnWhitelistActive).toBe(false)
  })

  it("non-MTN never reads admin_settings", async () => {
    const { client, reads } = fakeSupabase({ users: null, app_settings: settings, admin_settings: { value: { provider: "xpress" } } })
    expect((await resolveBuyerTier(client, "+233200000101", "Telecel")).mtnWhitelistActive).toBe(false)
    expect(reads).not.toContain("admin_settings")
  })

  it("looks the user up by local phone form for +233, 233 and local input", async () => {
    for (const phone of ["+233200000101", "233200000101", "0200000101"]) {
      const { client, lookups } = fakeSupabase({ users: null, app_settings: settings })
      await resolveBuyerTier(client, phone, "Telecel")
      expect(lookups.find((l) => l.table === "users" && l.col === "phone_number")?.val).toBe("0200000101")
    }
  })
})
