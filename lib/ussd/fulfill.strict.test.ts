import { describe, it, expect, vi, beforeEach } from "vitest"

const updates = vi.hoisted(() => [] as any[])
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      update: (patch: any) => ({
        eq: async (_c: string, id: string) => {
          updates.push({ table, patch, id })
          return { error: null }
        },
      }),
    }),
  }),
}))

const createMTNOrder = vi.hoisted(() => vi.fn())
const saveMTNTracking = vi.hoisted(() => vi.fn().mockResolvedValue("t"))
vi.mock("@/lib/mtn-fulfillment", () => ({
  isAutoFulfillmentEnabled: vi.fn().mockResolvedValue(true),
  createMTNOrder,
  saveMTNTracking,
  normalizePhoneNumber: (p: string) => p,
}))
vi.mock("@/lib/blacklist", () => ({ isPhoneBlacklisted: vi.fn().mockResolvedValue(false) }))
const notifyAdmins = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock("@/lib/sms-service", () => ({ notifyAdmins }))
const holdMtnOrder = vi.hoisted(() => vi.fn().mockResolvedValue({ held: true }))
vi.mock("@/lib/mtn-hold", () => ({ holdMtnOrder }))

import { fulfillUssdOrder } from "./fulfill"

describe("fulfillUssdOrder — strict supplier verification", () => {
  beforeEach(() => {
    updates.length = 0
    vi.clearAllMocks()
  })

  for (const errorType of ["SUPPLIER_NOT_APPROVED", "SUPPLIER_CHECK_UNAVAILABLE"] as const) {
    it(`${errorType} on a pinned supplier: pending, message returned, no tracking row, not held`, async () => {
      createMTNOrder.mockResolvedValue({ success: false, message: "Hubnet hasn't approved this number", error_type: errorType })
      const r = await fulfillUssdOrder("u1", "MTN", "0551234567", "1GB", true, "ussd_orders", "hubnet")
      expect(r).toEqual({ success: false, message: "Hubnet hasn't approved this number" })
      expect(createMTNOrder.mock.calls[0][0].provider).toBe("hubnet")
      expect(updates.map((u) => u.patch.order_status)).toEqual(["pending"])
      expect(saveMTNTracking).not.toHaveBeenCalled()
      expect(holdMtnOrder).not.toHaveBeenCalled()
      expect(notifyAdmins).not.toHaveBeenCalled()
    })
  }

  it("STRICT_HOLD passes errorType and reason to holdMtnOrder", async () => {
    createMTNOrder.mockResolvedValue({ success: false, held: true, message: "held", error_type: "STRICT_HOLD", strictHoldReason: "rejected" })
    const r = await fulfillUssdOrder("u1", "MTN", "0551234567", "1GB", false, "ussd_shop_orders")
    expect(r.held).toBe(true)
    expect(holdMtnOrder).toHaveBeenCalledWith({
      table: "ussd_shop_orders", orderId: "u1", phone: "0551234567", errorType: "STRICT_HOLD", strictReason: "rejected",
    })
    expect(saveMTNTracking).not.toHaveBeenCalled()
  })
})
