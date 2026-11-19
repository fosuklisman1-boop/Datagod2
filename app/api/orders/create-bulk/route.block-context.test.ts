import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/roles/require-capability", () => ({ requireCapability: vi.fn().mockResolvedValue(null) }))

const gate = vi.hoisted(() => vi.fn(async (phones: string[]) => ({ verdicts: new Map(), blocking: true, blocked: phones })))

const chain: any = new Proxy(function () {}, {
  get: (_t, p) => (p === "then" ? (r: any) => Promise.resolve({ data: null, error: null }).then(r) : chain),
  apply: () => chain,
})
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => chain, auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) } }),
}))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => chain } }))
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified: async () => ({ allowed: true }) }))
vi.mock("@/lib/customer-tracking-service", () => ({ customerTrackingService: {} }))
vi.mock("@/lib/blacklist", () => ({ isPhoneBlacklisted: vi.fn() }))
vi.mock("@/lib/mtn-fulfillment", () => ({
  isAutoFulfillmentEnabled: vi.fn(), createMTNOrder: vi.fn(), saveMTNTracking: vi.fn(), normalizePhoneNumber: (p: string) => p,
}))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: async () => ({ enabled: false, map: {} }) }))
vi.mock("@/lib/pricing/package-price", () => ({
  CustomPriceReadError: class extends Error {}, MSG_PRICES_UNAVAILABLE: "x", effectivePrice: vi.fn(), getCustomPrices: vi.fn(),
}))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({
  verifyRecipientsForOrder: gate, NOT_VERIFIED_CODE: "RECIPIENT_NOT_VERIFIED",
}))

import { POST } from "./route"

describe("POST /api/orders/create-bulk: block context", () => {
  it("tells the gate this is a dashboard bulk order by the signed-in user, with no purchaser phone", async () => {
    const req = new Request("http://x/api/orders/create-bulk", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ network: "MTN", orders: [{ phone_number: "0244123456", volume_gb: 1, network: "MTN", price: 5 }] }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(409)
    expect(gate).toHaveBeenCalledWith(["0244123456"], { context: { surface: "dashboard_bulk", userId: "user-1", product: "MTN" } })
  })
})
