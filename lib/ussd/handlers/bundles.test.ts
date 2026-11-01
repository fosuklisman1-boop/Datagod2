// lib/ussd/handlers/bundles.test.ts
// Custom-price coverage for the USSD bundle menu (fetchBundles) and the confirm/charge step (handleConfirm).
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  type T = { one?: unknown; list?: unknown[]; error?: unknown }
  const state = {
    tables: {} as Record<string, T>,
    inserts: {} as Record<string, any[]>,
  }
  const fake = {
    from: (table: string) => {
      const t = () => state.tables[table] ?? {}
      const res = (data: unknown) => ({ data, error: t().error ?? null, count: Array.isArray(data) ? data.length : 0 })
      const b: any = {
        select: () => b, eq: () => b, is: () => b, not: () => b, in: () => b, order: () => b,
        range: () => Promise.resolve(res(t().list ?? [])),
        limit: () => Promise.resolve(res(t().list ?? [])),
        single: () => Promise.resolve(res(t().one ?? null)),
        maybeSingle: () => Promise.resolve(res(t().one ?? null)),
        insert: (rows: any) => {
          ;(state.inserts[table] ??= []).push(...([] as any[]).concat(rows))
          const ib: any = { select: () => ib, single: () => Promise.resolve({ data: { id: "order-1" }, error: null }) }
          return ib
        },
        update: () => b,
        then: (r: any, j: any) => Promise.resolve(res(t().list ?? [])).then(r, j),
      }
      return b
    },
  }
  return { state, fake, after: vi.fn(), setSession: vi.fn(async () => {}) }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("next/server", () => ({ after: h.after }))
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

import { fetchBundles, handleConfirm } from "./bundles"
import { MSG_PRICES_UNAVAILABLE } from "@/lib/pricing/package-price"
import { chargeMobileMoney } from "../../paystack"

const PKG = { id: "p1", size: "1", price: 10, dealer_price: 8, is_available: true }

function customUser() {
  h.state.tables = {
    packages: { list: [PKG], one: PKG },
    users: { one: { pricing_mode: "custom" } },
    user_package_prices: { list: [{ package_id: "p1", price: 6 }] },
    app_settings: { one: { paystack_fee_percentage: 3 } },
  }
}

const session = (over: Record<string, unknown> = {}): any => ({
  step: "CONFIRM", network: "MTN", paystackProvider: "mtn", bundleId: "p1", bundleSize: "1", bundlePrice: 6,
  recipientPhone: "0244123456", dialingPhone: "+233200585542", effectivePriceTier: "dealer", userId: "u1", ...over,
})

beforeEach(() => {
  h.state.inserts = {}
  h.after.mockClear()
  h.setSession.mockClear()
  vi.mocked(chargeMobileMoney).mockClear()
  customUser()
})

describe("USSD custom prices", () => {
  it("(a) shows the custom price and confirms at it", async () => {
    const { bundles } = await fetchBundles("MTN", 0, "dealer", undefined, "u1")
    expect(bundles[0].price).toBe(6)

    await handleConfirm("1", "S1", session())
    const row = h.state.inserts["ussd_orders"][0]
    expect(row.package_id).toBe("p1")
    expect(row.amount).toBeCloseTo(6.18, 2) // 6 + 3% fee
    expect(h.after).toHaveBeenCalledTimes(1)
  })

  it("(b) refuses at confirm when the custom price read fails, with no order and no charge", async () => {
    h.state.tables.users = { one: null, error: { message: "boom" } }
    const r: any = await handleConfirm("1", "S1", session())
    expect(JSON.stringify(r)).toContain(MSG_PRICES_UNAVAILABLE)
    expect(h.state.inserts["ussd_orders"]).toBeUndefined()
    expect(h.after).not.toHaveBeenCalled()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  // Sub-agent tier: cost = the parent's live role price + the parent's ACTIVE wholesale margin (subAgentCosts).
  // The fake returns one row per table: users is the parent here. The stored parent_price (9) is stale.
  const catalogRow = (over: Record<string, unknown> = {}) =>
    ({ package_id: "p1", wholesale_margin: 2, parent_price: 9, packages: { ...PKG, network: "MTN" }, ...over })
  const parentIs = (user: Record<string, unknown>, rows: unknown[] = [catalogRow()]) => {
    h.state.tables.user_shops = { one: { user_id: "parent-1" } }
    h.state.tables.users = { one: user }
    h.state.tables.sub_agent_catalog = { list: rows }
  }
  const subAgent = (price: number) => session({ effectivePriceTier: "sub_agent", subAgentParentShopId: "shop-1", bundlePrice: price })

  it("(c) sub_agent tier: a stale parent_price is ignored; live dealer price 8 + margin 2 = 10, parent credited 2", async () => {
    parentIs({ role: "dealer" })
    const { bundles } = await fetchBundles("MTN", 0, "sub_agent", "shop-1", "u1")
    expect(bundles).toEqual([{ id: "p1", size: "1", price: 10 }])

    await handleConfirm("1", "S1", subAgent(10))
    const row = h.state.inserts["ussd_orders"][0]
    expect(row.amount).toBeCloseTo(10.3, 2)
    expect(row.parent_profit_amount).toBe(2)
  })

  it("(c2) sub_agent tier: a non-dealer parent's cost uses price (10 + 2)", async () => {
    parentIs({ role: "agent" })
    expect((await fetchBundles("MTN", 0, "sub_agent", "shop-1", "u1")).bundles[0].price).toBe(12)
    await handleConfirm("1", "S1", subAgent(12))
    expect(h.state.inserts["ussd_orders"][0]).toMatchObject({ parent_profit_amount: 2 })
  })

  it("(c3) sub_agent tier: a confirm at the old snapshot price is refused as a price change", async () => {
    parentIs({ role: "dealer" })
    const r: any = await handleConfirm("1", "S1", subAgent(9))
    expect(JSON.stringify(r)).toContain("Price changed to GHS 10.00")
    expect(h.state.inserts["ussd_orders"]).toBeUndefined()
  })

  it("(d) sub_agent tier credits the parent wholesale margin + the parent's saving; the price does not change", async () => {
    parentIs({ role: "dealer", pricing_mode: "custom" })
    await handleConfirm("1", "S1", subAgent(10))
    const row = h.state.inserts["ussd_orders"][0]
    expect(row.amount).toBeCloseTo(10.3, 2) // dealer 8 + margin 2, + 3% fee: unchanged by the parent's custom price
    expect(row.parent_profit_amount).toBe(4) // wholesale 2 + (parent dealer price 8 - parent custom 6)
  })

  it("(e) sub_agent tier refuses when the parent's prices cannot be read, with no order and no charge", async () => {
    parentIs({ role: "dealer", pricing_mode: "custom" })
    h.state.tables.user_shops = { one: null, error: { message: "boom" } }
    const r: any = await handleConfirm("1", "S1", subAgent(10))
    expect(JSON.stringify(r)).toContain(MSG_PRICES_UNAVAILABLE)
    expect(h.state.inserts["ussd_orders"]).toBeUndefined()
    expect(h.after).not.toHaveBeenCalled()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("(e2) sub_agent tier refuses when the parent's catalog cannot be read; the menu lists nothing", async () => {
    parentIs({ role: "dealer" })
    h.state.tables.sub_agent_catalog = { list: undefined, error: { message: "boom" } }
    expect(await fetchBundles("MTN", 0, "sub_agent", "shop-1", "u1")).toEqual({ bundles: [], total: 0 })
    const r: any = await handleConfirm("1", "S1", subAgent(10))
    expect(JSON.stringify(r)).toContain(MSG_PRICES_UNAVAILABLE)
    expect(h.state.inserts["ussd_orders"]).toBeUndefined()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("(f) sub_agent tier refuses a negative wholesale margin, with no order and no charge", async () => {
    parentIs({ role: "dealer" }, [catalogRow({ wholesale_margin: -1 })])
    expect((await fetchBundles("MTN", 0, "sub_agent", "shop-1", "u1")).bundles).toEqual([])
    const r: any = await handleConfirm("1", "S1", subAgent(7))
    expect(JSON.stringify(r)).toMatch(/no longer available/i)
    expect(h.state.inserts["ussd_orders"]).toBeUndefined()
    expect(h.after).not.toHaveBeenCalled()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("(g) sub_agent tier: no active parent row hides the package and refuses it (no fallback to the package price)", async () => {
    parentIs({ role: "dealer" }, [])
    expect(await fetchBundles("MTN", 0, "sub_agent", "shop-1", "u1")).toEqual({ bundles: [], total: 0 })
    const r: any = await handleConfirm("1", "S1", subAgent(10))
    expect(JSON.stringify(r)).toMatch(/no longer available/i)
    expect(h.state.inserts["ussd_orders"]).toBeUndefined()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("(h) sub_agent menu sorts by live price, then id, and pages after sorting", async () => {
    const rows = [7, 3, 5, 1, 6, 2, 4].map((n) =>
      catalogRow({ package_id: `p${n}`, wholesale_margin: 0, packages: { id: `p${n}`, size: String(n), network: "MTN", price: 10 - n, dealer_price: null, is_available: true } }))
    parentIs({ role: "agent" }, rows)
    const first = await fetchBundles("MTN", 0, "sub_agent", "shop-1", "u1")
    expect(first.total).toBe(7)
    expect(first.bundles.map(b => b.id)).toEqual(["p7", "p6", "p5", "p4", "p3"])
    const second = await fetchBundles("MTN", 1, "sub_agent", "shop-1", "u1")
    expect(second.bundles.map(b => [b.id, b.price])).toEqual([["p2", 8], ["p1", 9]])
  })
})
