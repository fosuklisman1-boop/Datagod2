import { describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({ admin: true, list: vi.fn(async (..._a: unknown[]): Promise<{ rows: unknown[]; truncated: boolean }> => ({ rows: [], truncated: false })) }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: async () => (h.admin ? { isAdmin: true } : { isAdmin: false, errorResponse: NextResponse.json({ error: "no" }, { status: 403 }) }),
}))
vi.mock("@/lib/refunds/http", () => ({
  refundDb: () => ({ db: true }),
  refundErrorResponse: () => NextResponse.json({ error: "Refund request failed" }, { status: 500 }),
}))
vi.mock("@/lib/refunds/hubtel-wallet", () => ({ listHubtelWalletAttention: h.list }))

import { GET } from "./route"

const req = () => new NextRequest("http://localhost/api/admin/refunds/wallet-attention")

describe("GET /api/admin/refunds/wallet-attention", () => {
  it("is admin-only", async () => {
    h.admin = false
    expect((await GET(req())).status).toBe(403)
    expect(h.list).not.toHaveBeenCalled()
    h.admin = true
  })

  it("returns the attention rows and whether the list was cut off", async () => {
    h.list.mockResolvedValueOnce({ rows: [{ paymentId: "p1" }], truncated: true })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rows: [{ paymentId: "p1" }], truncated: true })
  })

  it("fails loudly (500), never an empty list, when the list cannot be read", async () => {
    h.list.mockRejectedValueOnce(new Error("boom"))
    expect((await GET(req())).status).toBe(500)
  })
})
