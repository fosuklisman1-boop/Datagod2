import { describe, it, expect, vi } from "vitest"

const gate = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true))
const SHOP = "11111111-1111-4111-8111-111111111111"

const rows: Record<string, unknown> = {
  user_shops: { parent_shop_id: null, user_id: "owner-1", is_blocked: false, is_active: true },
  shop_packages: {
    profit_margin: 2, package_id: "p1",
    packages: { id: "p1", size: "5", price: 10, dealer_price: 8, is_available: true },
  },
}
function chainFor(table: string): any {
  const result = { data: rows[table] ?? null, error: null }
  const c: any = new Proxy(function () {}, {
    get: (_t, p) => (p === "then" ? (r: any) => Promise.resolve(result).then(r) : c),
    apply: () => c,
  })
  return c
}
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chainFor(t) }) }))
vi.mock("@/lib/blacklist", () => ({ isPhoneBlacklisted: vi.fn() }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(), notifyPriceManipulation: vi.fn() }))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: true, resetAt: 0 }) }))
vi.mock("@/lib/shop-token", () => ({ verifyShopSession: vi.fn() }))
vi.mock("@/lib/turnstile", () => ({ verifyTurnstileToken: vi.fn(), getRequestIp: () => "1.1.1.1", isTurnstileEnabled: async () => false }))
vi.mock("@/lib/storefront-otp", () => ({ isStorefrontOtpRequired: async () => false, isPhoneOtpVerified: vi.fn() }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: async () => ({ enabled: false, map: {} }) }))
vi.mock("@/lib/shop-commerce/pricing", async (orig) => ({
  ...(await orig<typeof import("@/lib/shop-commerce/pricing")>()),
  shopOwnerPricing: async () => ({ slug: "user", custom: new Map() }),
}))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({
  isRecipientBlocked: gate, NOT_VERIFIED_MESSAGE: "not verified", NOT_VERIFIED_CODE: "RECIPIENT_NOT_VERIFIED",
}))

import { POST } from "./route"

describe("POST /api/shop/orders/create: block context", () => {
  it("tells the gate this is a storefront order for the shop, with the verified product and price, and no purchaser phone", async () => {
    const req = new Request("http://x/api/shop/orders/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shop_id: SHOP, customer_email: "kofi.mensah@gmail.com", customer_phone: "0244123456", shop_package_id: "sp1",
        network: "MTN", volume_gb: 5, total_price: 12,
      }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(409)
    expect(gate).toHaveBeenCalledWith("MTN", "0244123456", { surface: "storefront", shopId: SHOP, product: "MTN 5GB", amount: 12 })
    expect(gate.mock.calls[0][2]).not.toHaveProperty("purchaserPhone")
  })
})
