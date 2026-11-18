import { describe, it, expect, vi } from "vitest"

const verify = vi.hoisted(() => vi.fn(async (phones: string[]) => ({ verdicts: new Map(), blocking: true, blocked: phones })))

const pkg = { id: "p1", price: 10, dealer_price: 8 }
const chain: any = new Proxy(function () {}, {
  get: (_t, p) => (p === "then" ? (r: any) => Promise.resolve({ data: pkg, error: null }).then(r) : chain),
  apply: () => chain,
})
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: () => chain }) }))
vi.mock("@/lib/api-auth", () => ({
  authenticateApiKey: async () => ({ id: "user-1", role: "dealer", api_key_id: "k1", rate_limit_per_min: 60, environment: "live" }),
  logApiRequest: async () => {},
}))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: true }) }))
vi.mock("@/lib/mtn-fulfillment", () => ({
  createMTNOrder: vi.fn(), saveMTNTracking: vi.fn(), normalizePhoneNumber: (p: string) => p, isAutoFulfillmentEnabled: vi.fn(),
}))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: async () => ({ enabled: false, map: {} }) }))
vi.mock("@/lib/pricing/package-price", () => ({
  CustomPriceReadError: class extends Error {}, MSG_PRICES_UNAVAILABLE: "x", effectivePrice: () => 8, getCustomPrices: async () => ({}),
}))
vi.mock("@/lib/roles/pricing", () => ({ roleBasePrices: async () => new Map([["p1", 8]]), priceWith: () => 8 }))
vi.mock("@/lib/sandbox", () => ({ placeSandboxOrder: vi.fn(), getSandboxOrder: vi.fn() }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({
  verifyRecipientsForOrder: verify, NOT_VERIFIED_MESSAGE: "not verified", NOT_VERIFIED_CODE: "RECIPIENT_NOT_VERIFIED",
}))

import { POST } from "./route"

describe("POST /api/v1/orders: block context", () => {
  it("tells the gate this is an api_v1 order by the key owner, with no purchaser phone", async () => {
    const req = new Request("http://x/api/v1/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ network: "MTN", volume_gb: 2, recipient: "0244123456", reference: "ref-123" }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(409)
    expect(verify).toHaveBeenCalledWith(["0244123456"], { context: { surface: "api_v1", userId: "user-1", product: "MTN 2GB" } })
  })
})
