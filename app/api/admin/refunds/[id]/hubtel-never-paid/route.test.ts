import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  mark: vi.fn(),
  audit: vi.fn(async (..._a: unknown[]) => {}),
  auditError: vi.fn(async (..._a: unknown[]) => {}),
  admin: { isAdmin: true, userId: "admin-1" as string | undefined, errorResponse: null as unknown },
}))

vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: async () => h.admin }))
vi.mock("@/lib/refunds/http", async (orig) => ({
  ...(await orig<typeof import("@/lib/refunds/http")>()),
  refundDb: () => ({}),
  loadStoredRefund: async () => ({ id: RF, gateway: "hubtel_send", status: "processing" }),
  auditRefund: h.audit,
  auditRefundError: h.auditError,
}))
vi.mock("@/lib/refunds/service", async (orig) => ({
  ...(await orig<typeof import("@/lib/refunds/service")>()),
  defaultDeps: () => ({}),
  markHubtelSendNeverPaid: (...a: unknown[]) => h.mark(...a),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: vi.fn() }) }))

import { POST } from "./route"
import { RefundError } from "@/lib/refunds/service"

const RF = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
const post = async (body: unknown, id = RF) =>
  (await POST(new NextRequest(`http://x/api/admin/refunds/${id}/hubtel-never-paid`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })) as Response

beforeEach(() => {
  vi.clearAllMocks()
  h.admin.isAdmin = true
  h.admin.userId = "admin-1"
  h.mark.mockResolvedValue({ status: "failed", message: "done", verdict: "no_record" })
})

describe("POST /api/admin/refunds/[id]/hubtel-never-paid", () => {
  it("needs the explicit confirmation", async () => {
    expect((await post({})).status).toBe(400)
    expect(h.mark).not.toHaveBeenCalled()
  })
  it("marks failed and audits who did it and what Hubtel said", async () => {
    const res = await post({ confirm: true })
    expect(res.status).toBe(200)
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), "admin-1", "order_refund_hubtel_never_paid", expect.objectContaining({ refundId: RF, verdict: "no_record", status: "failed" }))
  })
  it("a refusal is passed on and audited; nothing is reported as done", async () => {
    h.mark.mockRejectedValue(new RefundError("NOT_ELIGIBLE", "Hubtel may have paid this."))
    const res = await post({ confirm: true })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(h.audit).not.toHaveBeenCalled()
    expect(h.auditError).toHaveBeenCalledTimes(1)
  })
  it("rejects a bad id", async () => {
    expect((await post({ confirm: true }, "nope")).status).toBe(400)
  })
})
