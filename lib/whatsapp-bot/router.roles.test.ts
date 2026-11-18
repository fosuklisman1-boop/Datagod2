// lib/whatsapp-bot/router.roles.test.ts
// WhatsApp data menu (loadAllBundlesWa) prices through the role resolver: the session's price role (or, for a session
// created before roles, the one derived from its tier). Display path: a role read failure shows public prices; the shared
// handleConfirm re-prices (sessionPriceRole) and refuses.
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const sessions = new Map<string, any>()
  const rows = [
    { id: "p1", size: "1", price: 6, dealer_price: 5 },
    { id: "p2", size: "2", price: 11, dealer_price: 9 },
  ]
  const db = {
    from(table: string) {
      const chain: any = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: table === "packages" ? rows : null, error: null })
          if (prop === "maybeSingle" || prop === "single") return async () => ({ data: null, error: null })
          return () => chain
        },
      })
      return chain
    },
    rpc: async () => ({ data: false, error: null }),
  }
  return { sessions, db, rolePricesFor: vi.fn(), customPrices: new Map<string, number>() }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.db }))
vi.mock("./session", () => ({
  getWaSession: async (id: string) => h.sessions.get(id) ?? null,
  setWaSession: async (id: string, s: any) => { h.sessions.set(id, JSON.parse(JSON.stringify(s))) },
  deleteWaSession: async (id: string) => { h.sessions.delete(id) },
  extendWaSession: async () => {},
}))
vi.mock("@/lib/pricing/package-price", async (orig) => ({
  ...(await orig<typeof import("@/lib/pricing/package-price")>()),
  getCustomPrices: async () => h.customPrices,
}))
vi.mock("@/lib/roles/repo", async (orig) => ({
  ...(await orig<typeof import("@/lib/roles/repo")>()),
  rolePricesFor: h.rolePricesFor,
}))

import { waRouter } from "./router"
import { RoleReadError } from "@/lib/roles/repo"

const FROM = "233244123456"
// Slug -> price ladder stand-in: dealer 5/9, user 5.5/10 (a "user" row below public 6/11), anything else public.
const ladder = (slug: string, pkgs: any[]) =>
  new Map(pkgs.map((p) => [String(p.id), slug === "dealer" ? p.dealer_price : slug === "user" ? p.price - 0.5 : p.price]))
const seed = (over: Record<string, unknown>) =>
  h.sessions.set(FROM, { step: "SELECT_BUNDLE", dialingPhone: "0244123456", network: "MTN", userId: "u1", ...over })

beforeEach(() => {
  h.sessions.clear()
  h.customPrices = new Map()
  h.rolePricesFor.mockReset()
  h.rolePricesFor.mockImplementation(async (_c: unknown, slug: string, pkgs: any[]) => ladder(slug, pkgs))
})

describe("WhatsApp bundle menu prices through the role resolver", () => {
  it("uses the session's price role (dealer)", async () => {
    seed({ effectivePriceTier: "dealer", priceRole: "dealer" })
    const menu = await waRouter(FROM, "9")
    expect(menu).toContain("1. 1GB - GHS 5.00")
    expect(menu).toContain("2. 2GB - GHS 9.00")
    expect(h.rolePricesFor.mock.calls[0][1]).toBe("dealer")
  })

  it("prices a user role from its ladder row", async () => {
    seed({ effectivePriceTier: "regular", priceRole: "user" })
    const menu = await waRouter(FROM, "9")
    expect(menu).toContain("1. 1GB - GHS 5.50")
    expect(menu).toContain("2. 2GB - GHS 10.50")
  })

  it("admin messaging the bot keeps the public-tier price role (as_user)", async () => {
    seed({ effectivePriceTier: "regular", priceRole: "user" })
    await waRouter(FROM, "9")
    expect(h.rolePricesFor.mock.calls[0][1]).toBe("user")
  })

  it("a session created before roles (no priceRole) derives the role from its tier", async () => {
    seed({ effectivePriceTier: "dealer" })
    expect(await waRouter(FROM, "9")).toContain("1. 1GB - GHS 5.00")
    expect(h.rolePricesFor.mock.calls[0][1]).toBe("dealer")
    h.rolePricesFor.mockClear()
    seed({ effectivePriceTier: "regular" })
    await waRouter(FROM, "9")
    expect(h.rolePricesFor.mock.calls[0][1]).toBe("user")
  })

  it("custom prices still win over the role base", async () => {
    h.customPrices = new Map([["p1", 4.25]])
    seed({ effectivePriceTier: "dealer", priceRole: "dealer" })
    const menu = await waRouter(FROM, "9")
    expect(menu).toContain("1. 1GB - GHS 4.25")
    expect(menu).toContain("2. 2GB - GHS 9.00")
  })

  it("a role read failure shows public prices on the display path", async () => {
    h.rolePricesFor.mockRejectedValue(new RoleReadError())
    seed({ effectivePriceTier: "dealer", priceRole: "dealer" })
    const menu = await waRouter(FROM, "9")
    expect(menu).toContain("1. 1GB - GHS 6.00")
    expect(menu).toContain("2. 2GB - GHS 11.00")
  })

  it("menu = confirm: the picked price is the one the session's role priced", async () => {
    seed({ effectivePriceTier: "dealer", priceRole: "dealer" })
    await waRouter(FROM, "1")
    expect(h.sessions.get(FROM)).toMatchObject({ step: "ENTER_RECIPIENT", bundleId: "p1", bundlePrice: 5 })
    expect(h.rolePricesFor.mock.calls.every((c: any[]) => c[1] === "dealer")).toBe(true)
  })
})
