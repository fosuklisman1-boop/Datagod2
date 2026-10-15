import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { verifyAdminAccess, previewRefund } = vi.hoisted(() => ({ verifyAdminAccess: vi.fn(), previewRefund: vi.fn() }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess }))
vi.mock("@/lib/refunds/service", () => ({ previewRefund, defaultDeps: () => ({}) }))
vi.mock("@/lib/refunds/http", async (orig) => ({ ...(await orig<typeof import("@/lib/refunds/http")>()), refundDb: () => ({}) }))

import { POST } from "./route"

const ORDER_ID = "11111111-1111-4111-8111-111111111111"
const req = () => new NextRequest("http://localhost/api/admin/refunds/preview", {
  method: "POST", body: JSON.stringify({ table: "shop_orders", orderId: ORDER_ID }),
})
const contact = { name: "Ama", email: "a@x.com", phone: null, payerPhone: "0241112222", recipientPhone: "0243334444", payTo: "0241112222" }

beforeEach(() => {
  vi.clearAllMocks()
  previewRefund.mockResolvedValue({ order: { id: ORDER_ID }, gateways: [], contact })
})

describe("POST /api/admin/refunds/preview — customer contact card", () => {
  it("a signed-in admin gets the contact details", async () => {
    verifyAdminAccess.mockResolvedValue({ isAdmin: true, userId: "admin-1" })
    const body = await (await POST(req()))!.json()
    expect(body.contact).toEqual(contact)
  })
  it("a CRON_SECRET caller (no user) never receives customer PII", async () => {
    verifyAdminAccess.mockResolvedValue({ isAdmin: true, userId: undefined })
    const res = (await POST(req()))!
    expect(res.status).toBe(200)
    expect((await res.json()).contact).toBeNull()
  })
})
