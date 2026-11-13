// lib/ussd/handlers/bundles.select-network.test.ts
// Characterisation of handleSelectNetwork's buyer price-tier resolution. Written against the code BEFORE
// resolveBuyerTier was extracted; it must pass unchanged before and after.
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, unknown>,
    reads: [] as string[],
  }
  const fake = {
    from: (table: string) => {
      state.reads.push(table)
      const data = () => (state.tables[table] === undefined ? null : state.tables[table])
      const b: any = {
        select: () => b, eq: () => b, is: () => b, not: () => b, in: () => b, order: () => b,
        range: () => Promise.resolve({ data: [{ id: "p1", size: "1", price: 10, dealer_price: 8 }], count: 1, error: null }),
        single: () => Promise.resolve({ data: data(), error: null }),
        maybeSingle: () => Promise.resolve({ data: data(), error: null }),
      }
      return b
    },
  }
  return { state, fake, setSession: vi.fn(async (_id: string, _s: any) => {}) }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("next/server", () => ({ after: vi.fn() }))
vi.mock("../session", () => ({ setSession: h.setSession }))
vi.mock("../resolve-email", () => ({ resolveEmail: vi.fn(async () => "a@b.c") }))
vi.mock("../wallet-balance", () => ({ liveWalletBalance: vi.fn(async () => undefined) }))
vi.mock("../fulfill", () => ({ fulfillUssdOrder: vi.fn() }))
vi.mock("../../paystack", () => ({ chargeMobileMoney: vi.fn(), submitOtp: vi.fn() }))
vi.mock("../../sms-service", () => ({ sendSMS: vi.fn(), SMSTemplates: {} }))
vi.mock("../../whatsapp-bot/send", () => ({ sendWhatsAppText: vi.fn() }))
vi.mock("../../app-settings", () => ({ getJoinCommunityLink: vi.fn(async () => "") }))
vi.mock("../../network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn(async () => ({ enabled: false, map: {} })) }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({ isRecipientBlocked: vi.fn(async () => false), RECIPIENT_BLOCKED_PROMPT: "" }))
vi.mock("../../ussd-service-visibility", () => ({ getUssdServiceVisibility: vi.fn(async () => ({})) }))
vi.mock("@/lib/pricing/package-price", () => ({
  effectivePrice: (row: any) => row.price,
  getCustomPrices: vi.fn(async () => ({})),
  NO_CUSTOM_PRICES: {},
  MSG_PRICES_UNAVAILABLE: "",
}))
vi.mock("@/lib/shop-commerce/pricing", () => ({
  subAgentBundles: vi.fn(async () => [{ id: "p1", size: "1", price: 12 }]),
  subAgentCost: vi.fn(),
}))

import { handleSelectNetwork } from "./bundles"

const PHONE = "+233200000101"

async function run(input: string, tables: Record<string, unknown>) {
  h.state.tables = tables
  h.state.reads = []
  h.setSession.mockClear()
  await handleSelectNetwork(input, "S1", { step: "SELECT_NETWORK", dialingPhone: PHONE } as any)
  const written = h.setSession.mock.calls[0][1]
  return {
    written: {
      effectivePriceTier: written.effectivePriceTier,
      subAgentParentShopId: written.subAgentParentShopId,
      userId: written.userId,
      walletBalance: written.walletBalance,
      mtnWhitelistActive: written.mtnWhitelistActive,
      paystackProvider: written.paystackProvider,
    },
    reads: h.state.reads,
  }
}

const settings = { ussd_price_tier: "regular" }

beforeEach(() => {
  h.state.tables = {}
})

describe("handleSelectNetwork tier resolution", () => {
  it("no account: settings tier, nothing else", async () => {
    const r = await run("1", { users: null, app_settings: settings, admin_settings: null })
    expect(r.written).toEqual({
      effectivePriceTier: "regular", subAgentParentShopId: undefined, userId: undefined,
      walletBalance: undefined, mtnWhitelistActive: false, paystackProvider: "vod", // 020 prefix is Telecel: phone beats menu choice
    })
  })

  it("no account falls back to regular when settings are missing", async () => {
    const r = await run("2", { users: null, app_settings: null })
    expect(r.written.effectivePriceTier).toBe("regular")
  })

  it("no account uses a non-default settings tier", async () => {
    const r = await run("2", { users: null, app_settings: { ussd_price_tier: "dealer" } })
    expect(r.written.effectivePriceTier).toBe("dealer")
  })

  it("dealer with wallet", async () => {
    const r = await run("2", { users: { id: "u1", role: "dealer" }, app_settings: settings, wallets: { balance: "42.5" } })
    expect(r.written).toEqual({
      effectivePriceTier: "dealer", subAgentParentShopId: undefined, userId: "u1",
      walletBalance: 42.5, mtnWhitelistActive: false, paystackProvider: "vod",
    })
  })

  it("dealer without wallet row has undefined balance", async () => {
    const r = await run("2", { users: { id: "u1", role: "dealer" }, app_settings: settings, wallets: null })
    expect(r.written.walletBalance).toBeUndefined()
    expect(r.written.effectivePriceTier).toBe("dealer")
  })

  it("sub_agent with parent shop", async () => {
    const r = await run("2", {
      users: { id: "u2", role: "sub_agent" }, app_settings: settings,
      user_shops: { parent_shop_id: "shop-9" }, wallets: { balance: 7 },
    })
    expect(r.written).toEqual({
      effectivePriceTier: "sub_agent", subAgentParentShopId: "shop-9", userId: "u2",
      walletBalance: 7, mtnWhitelistActive: false, paystackProvider: "vod",
    })
  })

  it("sub_agent without parent shop falls back to regular", async () => {
    const r = await run("2", {
      users: { id: "u2", role: "sub_agent" }, app_settings: { ussd_price_tier: "dealer" },
      user_shops: null, wallets: { balance: 3 },
    })
    expect(r.written).toEqual({
      effectivePriceTier: "regular", subAgentParentShopId: undefined, userId: "u2",
      walletBalance: 3, mtnWhitelistActive: false, paystackProvider: "vod",
    })
  })

  it("customer role is regular even when settings tier differs", async () => {
    const r = await run("2", {
      users: { id: "u3", role: "customer" }, app_settings: { ussd_price_tier: "dealer" }, wallets: { balance: 1 },
    })
    expect(r.written).toEqual({
      effectivePriceTier: "regular", subAgentParentShopId: undefined, userId: "u3",
      walletBalance: 1, mtnWhitelistActive: false, paystackProvider: "vod",
    })
  })

  it("MTN with xpress sets mtnWhitelistActive and reads admin_settings", async () => {
    const r = await run("1", { users: null, app_settings: settings, admin_settings: { value: { provider: "xpress" } } })
    expect(r.written.mtnWhitelistActive).toBe(true)
    expect(r.reads).toContain("admin_settings")
  })

  it("MTN with codecraft also sets mtnWhitelistActive", async () => {
    const r = await run("1", { users: null, app_settings: settings, admin_settings: { value: { provider: "codecraft" } } })
    expect(r.written.mtnWhitelistActive).toBe(true)
  })

  it("MTN with datakazina leaves mtnWhitelistActive false", async () => {
    const r = await run("1", { users: null, app_settings: settings, admin_settings: { value: { provider: "datakazina" } } })
    expect(r.written.mtnWhitelistActive).toBe(false)
  })

  it("non-MTN network never reads admin_settings and is never whitelist-active", async () => {
    const r = await run("2", { users: null, app_settings: settings, admin_settings: { value: { provider: "xpress" } } })
    expect(r.written.mtnWhitelistActive).toBe(false)
    expect(r.reads).not.toContain("admin_settings")
  })

  it("normalises 233... and +233... dialing phones the same way (local form lookup)", async () => {
    // Lookup form is not observable through the fake; the result must still be identical for both forms.
    const a = await run("2", { users: { id: "u1", role: "dealer" }, app_settings: settings, wallets: { balance: 5 } })
    h.state.reads = []
    h.setSession.mockClear()
    await handleSelectNetwork("2", "S1", { step: "SELECT_NETWORK", dialingPhone: "233200000101" } as any)
    expect(h.setSession.mock.calls[0][1].userId).toBe(a.written.userId)
  })
})
