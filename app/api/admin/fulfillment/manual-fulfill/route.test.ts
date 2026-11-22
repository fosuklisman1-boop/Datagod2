import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  from: vi.fn(),
}))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: h.from }) }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: h.verify }))
vi.mock("@/lib/mtn-fulfillment", () => ({ createMTNOrder: vi.fn(), saveMTNTracking: vi.fn() }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(), SMSTemplates: {} }))
vi.mock("@/lib/blacklist", () => ({ isPhoneBlacklisted: vi.fn() }))
vi.mock("@/lib/push-service", () => ({ notifyAdminsPush: vi.fn() }))

import { NextRequest, NextResponse } from "next/server"
import { GET } from "./route"

const request = () => new NextRequest("http://localhost/api/admin/fulfillment/manual-fulfill")

/** A query whose every builder method chains and which resolves to the given rows. */
function query(rows: unknown[]) {
  const q: any = {}
  for (const m of ["select", "in", "eq", "order", "range"]) q[m] = () => q
  q.then = (ok: any, bad: any) => Promise.resolve({ data: rows, count: rows.length, error: null }).then(ok, bad)
  return q
}

describe("GET /api/admin/fulfillment/manual-fulfill", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.from.mockImplementation((table: string) =>
      query(
        table === "shop_orders"
          ? [{ id: "o1", network: "MTN", customer_phone: "test-phone", customer_email: "buyer@example.test", created_at: "2026-11-22T10:00:00Z" }]
          : [],
      ),
    )
  })

  // Live 2026-11-22: this GET answered 200 with customer phone, name and email to a request with no credentials.
  for (const status of [401, 403, 429]) {
    it(`returns the ${status} from the admin check and reads no orders`, async () => {
      h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "refused" }, { status }) })
      const req = request()
      const res = (await GET(req))!
      expect(h.verify).toHaveBeenCalledWith(req)
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ error: "refused" })
      expect(h.from).not.toHaveBeenCalled()
    })
  }

  it("reads no orders when the admin check throws", async () => {
    h.verify.mockRejectedValue(new Error("auth down"))
    const res = (await GET(request()))!
    expect(res.status).toBe(500)
    expect(h.from).not.toHaveBeenCalled()
  })

  it("still lists orders for an admin", async () => {
    h.verify.mockResolvedValue({ isAdmin: true, userId: "admin-1" })
    const res = (await GET(request()))!
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(1)
    expect(body.orders).toEqual([expect.objectContaining({ id: "o1", type: "shop" })])
  })
})
