import { describe, it, expect, vi, beforeEach } from "vitest"

// Table-serving fake (same style as app/api/orders/purchase/route.role-pricing.test.ts). The MTN gate is the
// observation point: it receives the verified total the order would be charged, and (returning true) stops the
// route with a 409 before any order row exists.
const db = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, any[]>,
    failTable: null as string | null,
    ops: [] as string[],
  }
  function builder(table: string): any {
    const rows = () => state.tables[table] ?? []
    const failed = () => state.failTable === table
    const b: any = new Proxy(function () {}, {
      get: (_t, p: string) => {
        if (["insert", "update", "upsert", "delete"].includes(p)) return () => (state.ops.push(`${table}.${p}`), b)
        if (p === "single" || p === "maybeSingle")
          return () => Promise.resolve(failed() ? { data: null, error: { message: "boom" } } : { data: rows()[0] ?? null, error: null })
        if (p === "then")
          return (r: any, j: any) =>
            Promise.resolve(failed() ? { data: null, error: { message: "boom" } } : { data: rows(), error: null }).then(r, j)
        return () => b
      },
    })
    return b
  }
  const client = {
    from: (t: string) => builder(t),
    rpc: async (name: string) => (state.ops.push(`rpc.${name}`), { data: null, error: null }),
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }
  return { state, client, gate: vi.fn(async (..._a: unknown[]) => true) }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => db.client }))
vi.mock("@/lib/blacklist", () => ({ isPhoneBlacklisted: vi.fn() }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(), notifyPriceManipulation: vi.fn(async () => {}) }))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: true, resetAt: 0 }) }))
vi.mock("@/lib/shop-token", () => ({ verifyShopSession: vi.fn() }))
vi.mock("@/lib/turnstile", () => ({ verifyTurnstileToken: vi.fn(), getRequestIp: () => "1.1.1.1", isTurnstileEnabled: async () => false }))
vi.mock("@/lib/storefront-otp", () => ({ isStorefrontOtpRequired: async () => false, isPhoneOtpVerified: vi.fn() }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: async () => ({ enabled: false, map: {} }) }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({
  isRecipientBlocked: db.gate, NOT_VERIFIED_MESSAGE: "not verified", NOT_VERIFIED_CODE: "RECIPIENT_NOT_VERIFIED",
}))

import { POST } from "./route"
import { MSG_PRICES_UNAVAILABLE } from "@/lib/pricing/package-price"

const SHOP = "11111111-1111-4111-8111-111111111111"
const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-sub", slug: "sub_agent", rank: null, is_system: true, archived_at: null },
  { id: "r-admin", slug: "admin", rank: null, is_system: true, archived_at: null },
]

// Package p1: public 10, dealer 8; shop margin 2.
function setup(opts: { role: string; mode?: string; custom?: Array<{ package_id: string; price: number }>; rolePrices?: any[] }) {
  db.state.tables = {
    user_shops: [{ parent_shop_id: null, user_id: "owner-1", is_blocked: false, is_active: true }],
    users: [{ role: opts.role, pricing_mode: opts.mode ?? null }],
    shop_packages: [{
      profit_margin: 2, package_id: "p1",
      packages: { id: "p1", size: "5", price: 10, dealer_price: 8, is_available: true },
    }],
    roles: ROLES,
    role_package_prices: opts.rolePrices ?? [{ role_id: "r-dealer", package_id: "p1", price: 8 }],
    user_package_prices: opts.custom ?? [],
  }
}

async function order(total: number) {
  const req = new Request("http://x/api/shop/orders/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      shop_id: SHOP, customer_email: "kofi.mensah@gmail.com", customer_phone: "0244123456", shop_package_id: "sp1",
      network: "MTN", volume_gb: 5, total_price: total,
    }),
  })
  const res = await POST(req as any)
  return { status: res.status, body: await res.json() }
}
const verifiedTotal = () => (db.gate.mock.calls[0][2] as { amount: number }).amount

beforeEach(() => {
  db.state.failTable = null
  db.state.ops = []
  db.gate.mockClear()
})

describe("POST /api/shop/orders/create: direct shop role pricing", () => {
  it("an admin-owned shop charges dealer price + margin", async () => {
    setup({ role: "admin" })
    const r = await order(10)
    expect(r.status).toBe(409)
    expect(verifiedTotal()).toBe(10)
  })

  it("a dealer-owned shop charges dealer price + margin", async () => {
    setup({ role: "dealer" })
    await order(10)
    expect(verifiedTotal()).toBe(10)
  })

  it("a user-owned shop charges public price + margin", async () => {
    setup({ role: "user" })
    await order(12)
    expect(verifiedTotal()).toBe(12)
  })

  it("a user role price row of 5.5 makes the shop charge 5.5 + margin (the order route reads the resolver)", async () => {
    setup({ role: "user", rolePrices: [{ role_id: "r-user", package_id: "p1", price: 5.5 }] })
    await order(7.5)
    expect(verifiedTotal()).toBe(7.5)
  })

  it("a custom-role owner is priced on the ladder (not public): role price + margin", async () => {
    setup({
      role: "gold",
      rolePrices: [{ role_id: "r-dealer", package_id: "p1", price: 8 }, { role_id: "r-gold", package_id: "p1", price: 7 }],
    })
    db.state.tables.roles = [...ROLES, { id: "r-gold", slug: "gold", rank: 5, is_system: false, archived_at: null }]
    await order(9)
    expect(verifiedTotal()).toBe(9)
  })

  it("a sub_agent-role (off-ladder) owner charges public price + margin", async () => {
    setup({ role: "sub_agent" })
    await order(12)
    expect(verifiedTotal()).toBe(12)
  })

  it("a custom-pricing owner: the customer still pays base + margin (custom price only raises the owner's profit)", async () => {
    setup({ role: "user", mode: "custom", custom: [{ package_id: "p1", price: 6.25 }] })
    await order(12)
    expect(verifiedTotal()).toBe(12)
  })

  it("a failed roles read refuses with 503 before anything is inserted or debited", async () => {
    setup({ role: "dealer" })
    db.state.failTable = "roles"
    const r = await order(10)
    expect(r.status).toBe(503)
    expect(r.body.error).toBe(MSG_PRICES_UNAVAILABLE)
    expect(db.gate).not.toHaveBeenCalled()
    expect(db.state.ops).toEqual([])
  })

  it("a failed role_package_prices read refuses with 503 the same way", async () => {
    setup({ role: "dealer" })
    db.state.failTable = "role_package_prices"
    const r = await order(10)
    expect(r.status).toBe(503)
    expect(db.state.ops).toEqual([])
  })
})
