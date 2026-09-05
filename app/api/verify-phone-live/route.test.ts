import { POST } from "./route"
import { NextRequest } from "next/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: vi.fn(async () => ({ allowed: true, remaining: 4, resetAt: Date.now() + 60000 })),
}))

vi.mock("@/lib/mtn-providers/customer-verification", () => ({
  checkCustomerFacingVerification: vi.fn(async (phones: string[]) =>
    phones.map(phone => ({ phone, verified: phone !== "0559999999" }))
  ),
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
    const { checkCustomerFacingVerification } = await import("@/lib/mtn-providers/customer-verification")
    ;(checkCustomerFacingVerification as any).mockRejectedValueOnce(new Error("db down"))
    const res = await POST(makeRequest({ phones: ["0551111111", "0552222222"] }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.results).toEqual([
      { phone: "0551111111", verified: true },
      { phone: "0552222222", verified: true },
    ])
  })
})
