import { describe, it, expect, beforeEach, vi } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    shop: null as Record<string, unknown> | null,
    settings: null as Record<string, unknown> | null,
    owner: null as Record<string, unknown> | null,
    customers: [] as unknown[],
  }
  const fake = {
    from: (table: string) => ({
      select: (_c?: string) => ({
        eq: (_col: string, _v: string) => ({
          maybeSingle: () => {
            if (table === "user_shops") return Promise.resolve({ data: state.shop, error: null })
            if (table === "shop_settings") return Promise.resolve({ data: state.settings, error: null })
            if (table === "users") return Promise.resolve({ data: state.owner, error: null })
            return Promise.resolve({ data: null, error: null })
          },
          order: (_o1?: string, _o2?: unknown) => ({
            limit: (_n: number) => Promise.resolve({ data: state.customers, error: null }),
          }),
        }),
      }),
    }),
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

import { getShopTokens, listShopCustomers } from "./shop-context-service"

// Minimal SmsAccount-shaped input
const ACC = { id: "a1", user_id: "u1", owner_type: "shop", owner_id: "s1", unit_balance: 0, status: "active" } as never

beforeEach(() => {
  h.state.shop = null
  h.state.settings = null
  h.state.owner = null
  h.state.customers = []
})

describe("getShopTokens", () => {
  it("builds shop_link from the subdomain when present", async () => {
    h.state.shop = { id: "s1", shop_name: "My Shop", shop_slug: "my-shop", subdomain: "myshop" }
    h.state.settings = { whatsapp_link: "https://wa.me/233241234567" }
    h.state.owner = { phone_number: "0241234567" }
    const t = await getShopTokens(ACC)
    expect(t.shop_name).toBe("My Shop")
    expect(t.shop_link).toBe("https://myshop.datagod.store")
    expect(t.shop_phone).toBe("0241234567")
    expect(t.shop_whatsapp).toBe("https://wa.me/233241234567")
  })

  it("falls back to the /shop/<slug> path when there's no subdomain", async () => {
    h.state.shop = { id: "s1", shop_name: "My Shop", shop_slug: "my-shop", subdomain: null }
    const t = await getShopTokens(ACC)
    expect(t.shop_link).toBe("https://datagod.store/shop/my-shop")
  })

  it("returns empty tokens when the account has no shop", async () => {
    h.state.shop = null
    const t = await getShopTokens(ACC)
    expect(t).toEqual({ shop_name: "", shop_link: "", shop_phone: "", shop_whatsapp: "" })
  })
})

describe("listShopCustomers", () => {
  it("maps rows and drops entries with no phone", async () => {
    h.state.shop = { id: "s1", shop_name: "X", shop_slug: "x", subdomain: null }
    h.state.customers = [
      { phone_number: "0241111111", customer_name: "Ama" },
      { phone_number: null, customer_name: "Ghost" },
      { phone_number: "0242222222", customer_name: null },
    ]
    const list = await listShopCustomers(ACC)
    expect(list).toEqual([
      { phone: "0241111111", name: "Ama" },
      { phone: "0242222222", name: null },
    ])
  })
})
