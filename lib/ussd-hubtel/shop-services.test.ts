// lib/ussd-hubtel/shop-services.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ isDealer: vi.fn(), baseRate: vi.fn(), push: vi.fn() }))
vi.mock("@/lib/shop-commerce/pricing", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/shop-commerce/pricing")>()),
  shopOwnerIsDealer: (...a: any[]) => h.isDealer(...a),
}))
vi.mock("@/lib/airtime-pricing", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/airtime-pricing")>()),
  airtimeBaseFeeRate: (...a: any[]) => h.baseRate(...a),
}))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: (...a: any[]) => h.push(...a) }))

import {
  capShopAirtimeMarkup, defaultShopServices, notifyLowTokens, shopAirtimeFeeRate, shopAirtimeQuote,
} from "./shop-services"

/** select/eq chains resolve to `row`; records the column list asked for. */
function fakeDb(row: Record<string, unknown> | null, rpc?: { data: unknown; error: { message: string } | null }) {
  const selects: string[] = []
  const b: any = {
    select: (cols: string) => { selects.push(cols); return b },
    eq: () => b,
    single: async () => ({ data: row, error: null }),
    maybeSingle: async () => ({ data: row, error: null }),
  }
  const rpcCalls: any[] = []
  const client: any = {
    from: () => b,
    rpc: async (...a: any[]) => { rpcCalls.push(a); return rpc ?? { data: true, error: null } },
  }
  return { client, selects, rpcCalls }
}

beforeEach(() => {
  h.isDealer.mockReset().mockResolvedValue(false)
  h.baseRate.mockReset().mockResolvedValue(3)
  h.push.mockReset().mockResolvedValue({ sent: 1, removed: 0 })
})

describe("capShopAirtimeMarkup (total fee rate never above 10%)", () => {
  it("keeps a markup that fits, caps one that does not, never negative", () => {
    expect(capShopAirtimeMarkup(3, 5)).toBe(5)
    expect(capShopAirtimeMarkup(3, 9)).toBe(7)
    expect(capShopAirtimeMarkup(3, -2)).toBe(0)
    expect(capShopAirtimeMarkup(12, 1)).toBe(0)
  })
})

describe("shopAirtimeQuote", () => {
  it("splits the paid amount fee-inclusively and gives the shop the markup share of what is delivered", () => {
    // 10 paid at 7% inclusive: fee 0.65, delivered 9.35; commission 9.35 x 2% = 0.187 -> 0.19
    expect(shopAirtimeQuote(10, { totalFeeRate: 7, merchantCommissionRate: 2 })).toEqual({ fee: 0.65, toDeliver: 9.35, commission: 0.19 })
  })
  it("no markup: no commission", () => {
    expect(shopAirtimeQuote(10, { totalFeeRate: 3, merchantCommissionRate: 0 }).commission).toBe(0)
  })
})

describe("shopAirtimeFeeRate", () => {
  it("dealer-owned shop: dealer base rate + the shop's markup for the network", async () => {
    h.isDealer.mockResolvedValue(true)
    const { client, selects } = fakeDb({ airtime_markup_mtn: "4" })
    expect(await shopAirtimeFeeRate(client, "shop-1", "MTN")).toEqual({ totalFeeRate: 7, merchantCommissionRate: 4 })
    expect(h.isDealer).toHaveBeenCalledWith("shop-1")
    expect(h.baseRate).toHaveBeenCalledWith("MTN", true)
    expect(selects).toContain("airtime_markup_mtn")
  })
  it("caps the markup so the total stays at 10%", async () => {
    h.baseRate.mockResolvedValue(8)
    const { client } = fakeDb({ airtime_markup_telecel: 5 })
    expect(await shopAirtimeFeeRate(client, "shop-1", "Telecel")).toEqual({ totalFeeRate: 10, merchantCommissionRate: 2 })
  })
  it("no markup column value: base rate only, no commission", async () => {
    const { client } = fakeDb(null)
    expect(await shopAirtimeFeeRate(client, "shop-1", "AT")).toEqual({ totalFeeRate: 3, merchantCommissionRate: 0 })
  })
})

describe("deductToken (deduct_ussd_shop_token)", () => {
  it("true only when the RPC says a token was taken", async () => {
    const ok = fakeDb(null, { data: true, error: null })
    expect(await defaultShopServices(ok.client).deductToken("code-1")).toBe(true)
    expect(ok.rpcCalls[0]).toEqual(["deduct_ussd_shop_token", { p_shop_code_id: "code-1" }])
    const none = fakeDb(null, { data: false, error: null })
    expect(await defaultShopServices(none.client).deductToken("code-1")).toBe(false)
  })
  it("rethrows an RPC error (never swallowed into false, so callers can tell 'error' from 'false'); the thrown message is generic and the original is logged safely", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const bad = fakeDb(null, { data: null, error: { message: "boom: Key (code)=(1234) gateway 504" } })
    const p = defaultShopServices(bad.client).deductToken("code-1")
    await expect(p).rejects.toThrow("deduct_ussd_shop_token failed")
    await p.catch(e => expect((e as Error).message).not.toMatch(/boom|gateway/))
    expect(err).toHaveBeenCalled()
    expect(JSON.stringify(err.mock.calls)).not.toContain("1234")
    err.mockRestore()
  })
  it("a non-true, non-error payload is false (only a definite false)", async () => {
    const nul = fakeDb(null, { data: null, error: null })
    expect(await defaultShopServices(nul.client).deductToken("code-1")).toBe(false)
  })
})

describe("notifyLowTokens", () => {
  it("pushes Uzo's low-session warning to the shop owner", async () => {
    const { client } = fakeDb({ user_id: "owner-9" })
    await notifyLowTokens(client, "shop-1", "Ama Data Hub")
    expect(h.push).toHaveBeenCalledWith("owner-9", {
      title: "Low Sessions Warning",
      body: 'Your USSD shop "Ama Data Hub" has only 10 sessions remaining. Top up to avoid service interruption.',
      data: { url: "/dashboard/ussd-shop" },
    })
  })
  it("no owner: no push; a failing push never throws", async () => {
    await notifyLowTokens(fakeDb(null).client, "shop-1", "X")
    expect(h.push).not.toHaveBeenCalled()
    h.push.mockRejectedValue(new Error("push down"))
    await expect(notifyLowTokens(fakeDb({ user_id: "o" }).client, "shop-1", "X")).resolves.toBeUndefined()
  })
})
