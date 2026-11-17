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

const mode = vi.hoisted(() => ({ m: "off" as "off" | "saved" | "saved_sms" }))
vi.mock("@/lib/blocked-numbers/notice", () => ({
  getNoticeMode: async () => mode.m,
  webCustomerNotice: (m: string) => `web:${m}`,
  dealerNotice: (m: string) => `dealer:${m}`,
}))

const maybeSingle = vi.fn()
const getUser = vi.fn()
const afterMock = vi.fn((cb: () => unknown) => { cb() })
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (cb: () => unknown) => afterMock(cb),
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    auth: { getUser: (t: string) => getUser(t) },
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

  describe("notice", () => {
    const blockedPhone = ["0559999999"]
    beforeEach(() => { mode.m = "saved_sms" })
    it("storefront preview gets the customer notice when blocking and a number is unverified", async () => {
      const body = await (await POST(makeRequest({ phones: blockedPhone, surface: "storefront_preview" }))).json()
      expect(body.notice).toBe("web:saved_sms")
      expect(body.blocking).toBe(true)
    })
    it("dashboard and bulk previews get the dealer notice", async () => {
      for (const surface of ["dashboard_preview", "dashboard_bulk_preview"]) {
        const body = await (await POST(makeRequest({ phones: blockedPhone, surface }))).json()
        expect(body.notice).toBe("dealer:saved_sms")
      }
    })
    it("no surface or another surface gives null", async () => {
      expect((await (await POST(makeRequest({ phones: blockedPhone }))).json()).notice).toBeNull()
      expect((await (await POST(makeRequest({ phones: blockedPhone, surface: "other" }))).json()).notice).toBeNull()
    })
    it("null when every number is verified", async () => {
      const body = await (await POST(makeRequest({ phones: ["0551111111"], surface: "storefront_preview" }))).json()
      expect(body.notice).toBeNull()
    })
    it("off mode still returns the legacy text via the builder", async () => {
      mode.m = "off"
      const body = await (await POST(makeRequest({ phones: blockedPhone, surface: "storefront_preview" }))).json()
      expect(body.notice).toBe("web:off")
    })
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
    const SHOP = "11111111-1111-4111-8111-111111111111"

    async function lastOpts() {
      const { verifyRecipientsForOrder } = await import("@/lib/mtn-providers/customer-verification")
      const calls = (verifyRecipientsForOrder as any).mock.calls
      return calls[calls.length - 1][1]
    }
    async function resolveCtx(opts: any) {
      return typeof opts.context === "function" ? await opts.context() : opts.context
    }
    function authedRequest(body: unknown, token = "tok") {
      return new NextRequest("http://localhost/api/verify-phone-live", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
    }

    beforeEach(() => {
      maybeSingle.mockReset()
      getUser.mockReset()
    })

    it("builds the preview context lazily and does no lookup until resolved", async () => {
      maybeSingle.mockResolvedValue({ data: { id: SHOP }, error: null })
      await POST(makeRequest({ phones: ["0551111111"], surface: "storefront_preview", shop_slug: "abc-resolve" }))
      const opts = await lastOpts()
      expect(maybeSingle).not.toHaveBeenCalled()
      expect(await resolveCtx(opts)).toEqual({ surface: "storefront_preview", shopId: SHOP })
    })

    it("hands the recorder to the defer hook (after) rather than awaiting it", async () => {
      await POST(makeRequest({ phones: ["0551111111"], surface: "storefront_preview", shop_slug: "abc" }))
      const opts = await lastOpts()
      const task = vi.fn(async () => {})
      opts.defer(task)
      expect(afterMock).toHaveBeenCalledTimes(1)
      expect(task).toHaveBeenCalledTimes(1)
    })

    it("uses shopId null for an unknown slug", async () => {
      maybeSingle.mockResolvedValue({ data: null, error: null })
      await POST(makeRequest({ phones: ["0551111111"], surface: "storefront_preview", shop_slug: "nope-unknown" }))
      expect(await resolveCtx(await lastOpts())).toEqual({ surface: "storefront_preview", shopId: null })
    })

    it("fails open when the slug lookup throws", async () => {
      maybeSingle.mockRejectedValue(new Error("db down"))
      const spy = vi.spyOn(console, "error").mockImplementation(() => {})
      const res = await POST(makeRequest({ phones: ["0551111111"], surface: "storefront_preview", shop_slug: "boom-slug" }))
      expect(res.status).toBe(200)
      expect(await resolveCtx(await lastOpts())).toEqual({ surface: "storefront_preview", shopId: null })
      spy.mockRestore()
    })

    it.each(["a,b)", "x".repeat(65), "has space", "UPPER;drop"])("skips the DB for invalid slug %#", async (slug) => {
      await POST(makeRequest({ phones: ["0551111111"], surface: "storefront_preview", shop_slug: slug }))
      expect(await resolveCtx(await lastOpts())).toEqual({ surface: "storefront_preview", shopId: null })
      expect(maybeSingle).not.toHaveBeenCalled()
    })

    it("does not record for a non-preview surface", async () => {
      await POST(makeRequest({ phones: ["0551111111"], surface: "storefront", shop_slug: "abc" }))
      expect((await lastOpts()).context).toBeUndefined()
    })

    it("does not record when surface is missing", async () => {
      await POST(makeRequest({ phones: ["0551111111"] }))
      expect((await lastOpts()).context).toBeUndefined()
    })

    it("dealer preview without a token passes no context but still answers", async () => {
      const res = await POST(makeRequest({ phones: ["0551111111"], surface: "dashboard_preview" }))
      expect(res.status).toBe(200)
      expect((await lastOpts()).context).toBeUndefined()
    })

    it("dealer preview with an invalid token resolves to no context", async () => {
      getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad" } })
      const res = await POST(authedRequest({ phones: ["0551111111"], surface: "dashboard_bulk_preview" }, "bad"))
      expect(res.status).toBe(200)
      expect(await resolveCtx(await lastOpts())).toBeNull()
    })

    it("dealer preview with a valid token takes userId from the session, never the body", async () => {
      getUser.mockResolvedValue({ data: { user: { id: "user-from-session" } }, error: null })
      await POST(authedRequest({
        phones: ["0551111111"], surface: "dashboard_preview", user_id: "spoofed", purchaser_phone: "0240000000", purchaserPhone: "0240000000",
      }, "good"))
      const ctx = await resolveCtx(await lastOpts())
      expect(getUser).toHaveBeenCalledWith("good")
      expect(ctx).toEqual({ surface: "dashboard_preview", userId: "user-from-session" })
      expect(JSON.stringify(ctx)).not.toContain("0240000000")
    })
  })
})
