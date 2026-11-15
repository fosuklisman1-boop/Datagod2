import { POST } from "./route"
import { NextRequest } from "next/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: vi.fn(async () => ({ allowed: true, remaining: 4, resetAt: Date.now() + 60000 })),
}))

vi.mock("@/lib/mtn-providers/customer-verification", () => ({
  verifyRecipientsForOrder: vi.fn(async (phones: string[]) => ({
    verdicts: new Map(phones.map(p => [p, p === "0558888888" ? null : p !== "0559999999"])),
    blocking: true,
    blocked: phones.filter(p => p === "0559999999"),
  })),
}))

const maybeSingle = vi.fn()
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: vi.fn(() => {
      const chain: any = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.or = () => chain
      chain.limit = () => chain
      chain.maybeSingle = () => maybeSingle()
      return chain
    }),
  },
}))

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/verify-phone-live", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("POST /api/verify-phone-live", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns per-phone verification results", async () => {
    const res = await POST(makeRequest({ phones: ["0551111111", "0559999999"] }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.results).toEqual([
      { phone: "0551111111", verified: true },
      { phone: "0559999999", verified: false },
    ])
    expect(body.blocking).toBe(true)
  })

  it("reports an unchecked number (outage/timeout) as verified so it is never blocked", async () => {
    const res = await POST(makeRequest({ phones: ["0558888888"] }))
    const body = await res.json()
    expect(body.results).toEqual([{ phone: "0558888888", verified: true }])
  })

  it("rejects a missing phones array with 400", async () => {
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(400)
  })

  it("rejects an empty phones array with 400", async () => {
    const res = await POST(makeRequest({ phones: [] }))
    expect(res.status).toBe(400)
  })

  it("rejects a phones array with non-string entries with 400", async () => {
    const res = await POST(makeRequest({ phones: ["0551111111", null, 123] }))
    expect(res.status).toBe(400)
  })

  it("caps the phones array at 100 entries with 400", async () => {
    const res = await POST(makeRequest({ phones: Array.from({ length: 101 }, (_, i) => `055000${i}`) }))
    expect(res.status).toBe(400)
  })

  it("returns 429 when rate limited", async () => {
    const { applyRateLimit } = await import("@/lib/rate-limiter")
    ;(applyRateLimit as any).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 60000 })
    const res = await POST(makeRequest({ phones: ["0551111111"] }))
    expect(res.status).toBe(429)
  })

  it("fails open (200, all verified) when the check function throws", async () => {
    const { verifyRecipientsForOrder } = await import("@/lib/mtn-providers/customer-verification")
    ;(verifyRecipientsForOrder as any).mockRejectedValueOnce(new Error("db down"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await POST(makeRequest({ phones: ["0551111111", "0552222222"] }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.results).toEqual([
      { phone: "0551111111", verified: true },
      { phone: "0552222222", verified: true },
    ])
    expect(body.blocking).toBe(false)
    spy.mockRestore()
  })

  describe("blocked-number recording context", () => {
    async function lastOpts() {
      const { verifyRecipientsForOrder } = await import("@/lib/mtn-providers/customer-verification")
      const calls = (verifyRecipientsForOrder as any).mock.calls
      return calls[calls.length - 1][1]
    }

    it("passes a preview context with the resolved shop id", async () => {
      maybeSingle.mockResolvedValue({ data: { id: "11111111-1111-4111-8111-111111111111" }, error: null })
      await POST(makeRequest({ phones: ["0551111111"], surface: "storefront_preview", shop_slug: "abc-resolve" }))
      const opts = await lastOpts()
      expect(opts.context).toEqual({ surface: "storefront_preview", shopId: "11111111-1111-4111-8111-111111111111" })
    })

    it("uses shopId null for an unknown slug", async () => {
      maybeSingle.mockResolvedValue({ data: null, error: null })
      await POST(makeRequest({ phones: ["0551111111"], surface: "storefront_preview", shop_slug: "nope-unknown" }))
      expect((await lastOpts()).context).toEqual({ surface: "storefront_preview", shopId: null })
    })

    it("fails open when the slug lookup throws", async () => {
      maybeSingle.mockRejectedValue(new Error("db down"))
      const res = await POST(makeRequest({ phones: ["0551111111"], surface: "storefront_preview", shop_slug: "boom-slug" }))
      expect(res.status).toBe(200)
      expect((await lastOpts()).context).toEqual({ surface: "storefront_preview", shopId: null })
    })

    it("does not record for a non-preview surface", async () => {
      await POST(makeRequest({ phones: ["0551111111"], surface: "storefront", shop_slug: "abc" }))
      expect((await lastOpts()).context).toBeUndefined()
    })

    it("does not record when surface is missing", async () => {
      await POST(makeRequest({ phones: ["0551111111"] }))
      expect((await lastOpts()).context).toBeUndefined()
    })

    it("never forwards a purchaser phone from the body", async () => {
      maybeSingle.mockResolvedValue({ data: null, error: null })
      await POST(makeRequest({
        phones: ["0551111111"], surface: "dashboard_preview", purchaser_phone: "0240000000", purchaserPhone: "0240000000",
      }))
      const ctx = (await lastOpts()).context
      expect(ctx.surface).toBe("dashboard_preview")
      expect(JSON.stringify(ctx)).not.toContain("0240000000")
      expect(ctx.purchaserPhone).toBeUndefined()
    })
  })
})
