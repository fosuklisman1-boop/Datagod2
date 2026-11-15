import { describe, it, expect, vi } from "vitest"

const gate = vi.hoisted(() => vi.fn(async () => true))

// Any chained query resolves to an empty result; auth resolves to a fixed user.
const chain: any = new Proxy(function () {}, {
  get: (_t, p) => (p === "then" ? (r: any) => Promise.resolve({ data: null, error: null }).then(r) : chain),
  apply: () => chain,
})
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => chain, auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "a@b.c" } }, error: null }) } }),
}))
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified: async () => ({ allowed: true }) }))
vi.mock("@/lib/notification-service", () => ({ notificationTemplates: {} }))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn() }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn() }))
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
  isRecipientBlocked: gate, NOT_VERIFIED_MESSAGE: "not verified", NOT_VERIFIED_CODE: "RECIPIENT_NOT_VERIFIED",
}))

import { POST } from "./route"

describe("POST /api/orders/purchase: block context", () => {
  it("tells the gate this is a dashboard order by the signed-in user, with no purchaser phone", async () => {
    const req = new Request("http://x/api/orders/purchase", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ packageId: "p1", network: "MTN", size: "5", price: 25, phoneNumber: "0244123456" }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(409)
    expect(gate).toHaveBeenCalledWith("MTN", "0244123456", { surface: "dashboard", userId: "user-1", product: "MTN 5", amount: 25 })
    expect(gate.mock.calls[0][2]).not.toHaveProperty("purchaserPhone")
  })
})
