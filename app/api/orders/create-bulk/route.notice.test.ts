import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/roles/require-capability", () => ({ requireCapability: vi.fn().mockResolvedValue(null) }))

const mode = vi.hoisted(() => ({ m: "off" as "off" | "saved" | "saved_sms" }))
vi.mock("@/lib/blocked-numbers/notice", () => ({ getNoticeMode: async () => mode.m }))

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

async function refuse() {
  const req = new Request("http://x/api/orders/create-bulk", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({ network: "MTN", orders: [{ phone_number: "0244123456", volume_gb: 1, network: "MTN", price: 5 }] }),
  })
  const res = await POST(req as any)
  return { status: res.status, body: await res.json() }
}

describe("POST /api/orders/create-bulk: refusal message by blocked-numbers mode", () => {
  it("off: the legacy message, byte for byte", async () => {
    mode.m = "off"
    const r = await refuse()
    expect(r.status).toBe(409)
    expect(r.body.error).toBe("1 number(s) are not verified for MTN data. Remove them and resubmit.")
    expect(r.body.code).toBe("RECIPIENT_NOT_VERIFIED")
  })

  for (const m of ["saved", "saved_sms"] as const) {
    it(`${m}: keeps the count and says the numbers were saved; status and code unchanged`, async () => {
      mode.m = m
      const r = await refuse()
      expect(r.status).toBe(409)
      expect(r.body.code).toBe("RECIPIENT_NOT_VERIFIED")
      expect(r.body.error).toBe(
        "1 number(s) aren't ready for MTN data yet. We've saved them to Blocked Numbers on your dashboard and will notify you when they're ready. Remove them and resubmit."
      )
    })
  }
})
