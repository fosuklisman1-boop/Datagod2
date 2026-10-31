import { describe, it, expect } from "vitest"
import { decideTier, priceForTier, resolveCaller, isDataBlocked } from "./catalog"

// Minimal chainable fake: every builder method returns the builder, which is also
// awaitable/terminal-resolvable with { data: null }. Records .eq() and rpc() args.
function fakeSupabase() {
  const eqCalls: [string, unknown][] = []
  const rpcCalls: [string, Record<string, unknown>][] = []
  const builder: any = {
    select: () => builder,
    is: () => builder,
    not: () => builder,
    eq: (col: string, val: unknown) => { eqCalls.push([col, val]); return builder },
    maybeSingle: async () => ({ data: null }),
    single: async () => ({ data: null }),
  }
  const client: any = {
    from: () => builder,
    rpc: async (name: string, args: Record<string, unknown>) => { rpcCalls.push([name, args]); return { data: false } },
  }
  return { client, eqCalls, rpcCalls }
}

const FORMS = ["+233200585542", "233200585542", "0200585542"]

describe("phone normalisation in lookups", () => {
  it.each(FORMS)("resolveCaller looks up the local number for %s", async (input) => {
    const { client, eqCalls } = fakeSupabase()
    await resolveCaller(client, input)
    expect(eqCalls).toContainEqual(["phone_number", "0200585542"])
  })
  it.each(FORMS)("isDataBlocked passes local_phone for %s", async (input) => {
    const { client, rpcCalls } = fakeSupabase()
    await isDataBlocked(client, input)
    expect(rpcCalls[0][0]).toBe("has_completed_purchase")
    expect(rpcCalls[0][1].local_phone).toBe("0200585542")
  })
})

describe("decideTier", () => {
  it("falls back to the global default for unknown callers", () => {
    expect(decideTier("regular", undefined, null)).toEqual({ tier: "regular" })
    expect(decideTier("dealer", undefined, null)).toEqual({ tier: "dealer" })
  })
  it("dealers get dealer pricing", () => {
    expect(decideTier("regular", "dealer", null)).toEqual({ tier: "dealer" })
  })
  it("sub_agents with a parent shop get sub_agent; without one get regular", () => {
    expect(decideTier("regular", "sub_agent", "shop-1")).toEqual({ tier: "sub_agent", parentShopId: "shop-1" })
    expect(decideTier("regular", "sub_agent", null)).toEqual({ tier: "regular" })
  })
  it("any other registered user is regular", () => {
    expect(decideTier("dealer", "user", null)).toEqual({ tier: "regular" })
  })
})

describe("priceForTier", () => {
  const pkg = { price: 10, dealer_price: 8 }
  it("regular uses price", () => expect(priceForTier(pkg, "regular")).toEqual({ price: 10, parentProfit: null }))
  it("dealer uses dealer_price when set and > 0", () => {
    expect(priceForTier(pkg, "dealer")!.price).toBe(8)
    expect(priceForTier({ price: 10, dealer_price: 0 }, "dealer")!.price).toBe(10)
    expect(priceForTier({ price: 10, dealer_price: null }, "dealer")!.price).toBe(10)
  })
  it("sub_agent uses the parent's live offer (cost and parent profit)", () => {
    expect(priceForTier(pkg, "sub_agent", { cost: 10, parentProfit: 2 })).toEqual({ price: 10, parentProfit: 2 })
  })
  it("sub_agent without an offer (the parent does not offer it) is refused: null, never the package price", () => {
    expect(priceForTier(pkg, "sub_agent", null)).toBeNull()
    expect(priceForTier(pkg, "sub_agent")).toBeNull()
  })
})

describe("priceForTier with custom prices", () => {
  const pkg = { id: "p1", price: 10, dealer_price: 8 }
  it("custom price wins on the dealer and regular tiers", () => {
    expect(priceForTier(pkg, "dealer", null, new Map([["p1", 6]]))!.price).toBe(6)
    expect(priceForTier(pkg, "regular", null, new Map([["p1", 6]]))!.price).toBe(6)
  })
  it("the sub-agent's own custom prices never change the sub_agent price or the parent's profit", () => {
    expect(priceForTier(pkg, "sub_agent", { cost: 10, parentProfit: 2 }, new Map([["p1", 2]]))).toEqual({ price: 10, parentProfit: 2 })
  })
  it("no custom prices = unchanged", () => {
    expect(priceForTier(pkg, "dealer")!.price).toBe(8)
  })
})
