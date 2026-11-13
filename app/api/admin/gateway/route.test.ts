import { GET, PUT } from "./route"
import { NextRequest, NextResponse } from "next/server"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { deriveFromLegacy } from "@/lib/payment-gateway/config"

const verifyMock = vi.fn()
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: (...a: unknown[]) => verifyMock(...a),
}))

const upsertMock = vi.fn(async (..._a: unknown[]) => ({ error: null }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({ upsert: upsertMock }) },
}))

vi.mock("@/lib/payment-gateway/read-config", () => ({
  GATEWAY_CONFIG_KEY: "payment_gateway_config",
  getGatewayConfig: async () => deriveFromLegacy({ storefrontDirect: false, walletDirect: false }),
  invalidateGatewayConfigCache: vi.fn(),
}))

const base = () => deriveFromLegacy({ storefrontDirect: false, walletDirect: false })
const put = (config: unknown) =>
  new NextRequest("http://localhost/api/admin/gateway", {
    method: "PUT",
    body: JSON.stringify({ config }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  verifyMock.mockResolvedValue({ isAdmin: true, userId: "admin-1", userEmail: "a@x" })
})
afterEach(() => {
  delete process.env.HUBTEL_RELAY_SECRET
})

describe("/api/admin/gateway", () => {
  it("returns the auth error response for non-admins", async () => {
    const denied = NextResponse.json({ error: "nope" }, { status: 403 })
    verifyMock.mockResolvedValue({ isAdmin: false, errorResponse: denied })
    const res = await GET(new NextRequest("http://localhost/api/admin/gateway"))
    expect(res!.status).toBe(403)
    const res2 = await PUT(put(base()))
    expect(res2!.status).toBe(403)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("rejects hubtel gateway while Hubtel is not ready", async () => {
    const c = base()
    c.surfaces.storefront.gateway = "hubtel"
    const res = await PUT(put(c))
    expect(res!.status).toBe(400)
    expect((await res!.json()).error).toBe("Hubtel is not configured")
  })

  it("rejects checkout mode on ussd", async () => {
    const c = base()
    c.surfaces.ussd.mode = "checkout"
    const res = await PUT(put(c))
    expect(res!.status).toBe(400)
    expect((await res!.json()).error).toBe("ussd must use direct mode")
  })

  it("saves a valid config", async () => {
    const c = base()
    c.surfaces.storefront.mode = "direct"
    const res = await PUT(put(c))
    expect(res!.status).toBe(200)
    expect((await res!.json()).config.surfaces.storefront.mode).toBe("direct")
    expect((upsertMock.mock.calls[0] as any)[0][0].key).toBe("payment_gateway_config")
  })

  it("rejects checkout mode on sms_order", async () => {
    const c = base()
    c.surfaces.sms_order.mode = "checkout"
    const res = await PUT(put(c))
    expect(res!.status).toBe(400)
    expect((await res!.json()).error).toBe("sms_order must use direct mode")
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("GET reports hubtel not ready and never leaks env values", async () => {
    process.env.HUBTEL_RELAY_SECRET = "s3cret"
    const res = await GET(new NextRequest("http://localhost/api/admin/gateway"))
    const text = await res!.text()
    expect(text).not.toContain("s3cret")
    const body = JSON.parse(text)
    expect(body.success).toBe(true)
    expect(body.hubtel.ready).toBe(false)
    expect(body.hubtel.missing).toContain("HUBTEL_RELAY_URL")
    expect(body.hubtel.missing).not.toContain("HUBTEL_RELAY_SECRET")
  })
})
