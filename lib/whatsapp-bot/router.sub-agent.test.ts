// lib/whatsapp-bot/router.sub-agent.test.ts
// WhatsApp data menu for sub-agents (loadAllBundlesWa): the list and the price carried into the order session are the
// parent's LIVE cost from the shared subAgentBundles (role price + active wholesale margin), never a stored parent_price.
// subAgentBundles' own arithmetic is covered in lib/shop-commerce/pricing.test.ts; the confirm step is handleConfirm
// (lib/ussd/handlers/bundles.test.ts).
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const sessions = new Map<string, any>()
  const db = {
    from() {
      const chain: any = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: null, error: null })
          if (prop === "maybeSingle" || prop === "single") return async () => ({ data: null, error: null })
          return () => chain
        },
      })
      return chain
    },
    rpc: async () => ({ data: false, error: null }),
  }
  return { sessions, db, subAgentBundles: vi.fn() }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.db }))
vi.mock("./session", () => ({
  getWaSession: async (id: string) => h.sessions.get(id) ?? null,
  setWaSession: async (id: string, s: any) => { h.sessions.set(id, JSON.parse(JSON.stringify(s))) },
  deleteWaSession: async (id: string) => { h.sessions.delete(id) },
  extendWaSession: async () => {},
}))
vi.mock("@/lib/shop-commerce/pricing", async (orig) => ({
  ...(await orig<typeof import("@/lib/shop-commerce/pricing")>()),
  subAgentBundles: h.subAgentBundles,
}))

import { waRouter } from "./router"

const FROM = "233244123456"
const atBundles = () => h.sessions.set(FROM, {
  step: "SELECT_BUNDLE", dialingPhone: "0244123456", network: "MTN",
  effectivePriceTier: "sub_agent", subAgentParentShopId: "parent-shop", userId: "u1",
})

beforeEach(() => {
  h.sessions.clear()
  h.subAgentBundles.mockReset()
})

describe("WhatsApp sub_agent bundle menu", () => {
  it("lists the parent's live offers and carries the live price into the order session", async () => {
    h.subAgentBundles.mockResolvedValue([{ id: "p1", size: "1", price: 10 }, { id: "p2", size: "2", price: 18 }])
    atBundles()
    const menu = await waRouter(FROM, "9") // out of range: re-shows the list
    expect(menu).toContain("1. 1GB - GHS 10.00")
    expect(menu).toContain("2. 2GB - GHS 18.00")
    expect(h.subAgentBundles).toHaveBeenCalledWith("parent-shop", "MTN", expect.anything())

    await waRouter(FROM, "1")
    expect(h.sessions.get(FROM)).toMatchObject({ step: "ENTER_RECIPIENT", bundleId: "p1", bundlePrice: 10 })
  })

  it("a read failure lists nothing (the confirm step refuses on its own read)", async () => {
    h.subAgentBundles.mockRejectedValue(new Error("boom"))
    atBundles()
    const menu = await waRouter(FROM, "1")
    expect(menu).not.toMatch(/GHS/)
    expect(h.sessions.get(FROM)).toMatchObject({ step: "SELECT_BUNDLE" })
  })
})
