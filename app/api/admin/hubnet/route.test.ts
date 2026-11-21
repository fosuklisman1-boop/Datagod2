import { GET } from "./route"
import { NextRequest, NextResponse } from "next/server"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const verifyMock = vi.fn()
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: (...a: unknown[]) => verifyMock(...a),
}))

const balanceMock = vi.fn()
vi.mock("@/lib/mtn-providers/hubnet-provider", () => ({
  HubnetProvider: class {
    checkBalance() {
      return balanceMock()
    }
  },
}))

const get = (q = "?action=balance") => new NextRequest(`http://localhost/api/admin/hubnet${q}`)

beforeEach(() => {
  vi.clearAllMocks()
  verifyMock.mockResolvedValue({ isAdmin: true, userId: "admin-1" })
  balanceMock.mockResolvedValue(42.5)
  process.env.HUBNET_API_KEY = "secret-key-value"
  process.env.HUBNET_WEBHOOK_TOKEN = "secret-token-value"
  delete process.env.HUBNET_MODE
})
afterEach(() => {
  delete process.env.HUBNET_API_KEY
  delete process.env.HUBNET_WEBHOOK_TOKEN
  delete process.env.HUBNET_MODE
})

describe("/api/admin/hubnet", () => {
  it("returns the auth error response for non-admins", async () => {
    verifyMock.mockResolvedValue({
      isAdmin: false,
      errorResponse: NextResponse.json({ error: "nope" }, { status: 403 }),
    })
    const res = await GET(get())
    expect(res.status).toBe(403)
    expect(balanceMock).not.toHaveBeenCalled()
  })

  it("returns balance, mode and configured without secrets", async () => {
    const res = await GET(get())
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ balance: 42.5, mode: "live", configured: true })
    expect(text).not.toContain("secret-key-value")
    expect(text).not.toContain("secret-token-value")
  })

  it("reports test mode", async () => {
    process.env.HUBNET_MODE = "test"
    const body = await (await GET(get())).json()
    expect(body.mode).toBe("test")
  })

  it("skips the balance call when unconfigured", async () => {
    delete process.env.HUBNET_API_KEY
    const body = await (await GET(get())).json()
    expect(body).toEqual({ balance: null, mode: "live", configured: false })
    expect(balanceMock).not.toHaveBeenCalled()
  })

  it("rejects unknown actions", async () => {
    expect((await GET(get("?action=x"))).status).toBe(400)
  })
})
