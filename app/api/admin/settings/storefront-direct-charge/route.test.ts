import { POST } from "./route"
import { NextRequest, NextResponse } from "next/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

const verifyMock = vi.fn()
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: (...a: unknown[]) => verifyMock(...a),
}))

const setSurfaceModes = vi.fn(async (..._a: unknown[]) => ({}))
vi.mock("@/lib/payment-gateway/write-config", () => ({
  setSurfaceModes: (...a: unknown[]) => setSurfaceModes(...a),
}))
vi.mock("@/lib/payment-gateway/read-config", () => ({ getGatewayConfig: vi.fn() }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))

const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/admin/settings/storefront-direct-charge", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  verifyMock.mockResolvedValue({ isAdmin: true, userId: "admin-1", userEmail: "a@x" })
})

describe("POST /api/admin/settings/storefront-direct-charge", () => {
  it("sets exactly the storefront surface", async () => {
    const res = await post({ enabled: true })
    expect(res!.status).toBe(200)
    expect(setSurfaceModes).toHaveBeenCalledTimes(1)
    const [, surfaces, mode] = setSurfaceModes.mock.calls[0] as any
    expect(surfaces).toEqual(["storefront"])
    expect(mode).toBe("direct")
  })

  it("enabled:false maps to checkout", async () => {
    await post({ enabled: false })
    expect((setSurfaceModes.mock.calls[0] as any)[2]).toBe("checkout")
  })

  it("non-boolean enabled -> 400 and nothing is written", async () => {
    const res = await post({ enabled: "yes" })
    expect(res!.status).toBe(400)
    expect(setSurfaceModes).not.toHaveBeenCalled()
  })

  it("a throw from setSurfaceModes -> 500", async () => {
    setSurfaceModes.mockRejectedValueOnce(new Error("boom"))
    const res = await post({ enabled: true })
    expect(res!.status).toBe(500)
  })

  it("non-admin gets the auth error and nothing is written", async () => {
    verifyMock.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "nope" }, { status: 403 }) })
    const res = await post({ enabled: true })
    expect(res!.status).toBe(403)
    expect(setSurfaceModes).not.toHaveBeenCalled()
  })
})
