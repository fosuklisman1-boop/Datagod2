import { describe, it, expect, vi, beforeEach } from "vitest"

// Strict supplier verification in processManualFulfillment: an admin-pinned
// supplier that refuses (SUPPLIER_NOT_APPROVED / SUPPLIER_CHECK_UNAVAILABLE)
// leaves the order pending with no tracking write, no retry_count bump and no
// admin alert; a STRICT_HOLD is held as a strict hold.

const updates = vi.hoisted(() => [] as any[])
const tracking = vi.hoisted(() => ({ rows: [] as any[] }))

vi.mock("@supabase/supabase-js", () => {
  function chain(table: string, mode: "select" | "update", patch?: any) {
    const c: any = {
      select: () => c,
      eq: () => c,
      in: () => c,
      order: () => c,
      limit: () => c,
      single: () =>
        Promise.resolve({
          data: { id: "order-uuid-1", network: "MTN", volume_gb: 1, customer_phone: "0551234567", customer_name: "x", order_status: "pending", queue: null },
          error: null,
        }),
      then: (resolve: any) => {
        if (mode === "update") updates.push({ table, patch })
        const data = mode === "update" ? [{ id: "order-uuid-1" }] : table === "mtn_fulfillment_tracking" ? tracking.rows : []
        resolve({ data, error: null })
      },
    }
    return c
  }
  return {
    createClient: () => ({
      from: (table: string) => ({
        select: () => chain(table, "select"),
        update: (patch: any) => chain(table, "update", patch),
        insert: (row: any) => {
          updates.push({ table, insert: row })
          return Promise.resolve({ data: null, error: null })
        },
      }),
    }),
  }
})

const createMTNOrder = vi.hoisted(() => vi.fn())
const saveMTNTracking = vi.hoisted(() => vi.fn().mockResolvedValue("t"))
vi.mock("@/lib/mtn-fulfillment", () => ({ createMTNOrder, saveMTNTracking, checkMTNOrderStatus: vi.fn() }))
const notifyAdmins = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: vi.fn().mockResolvedValue(undefined),
  notifyAdmins,
  SMSTemplates: { fulfillmentFailed: () => "failed", orderPaymentConfirmed: () => "ok" },
}))
const notifyAdminsPush = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock("@/lib/push-service", () => ({ notifyAdminsPush }))
vi.mock("@/lib/blacklist", () => ({ isPhoneBlacklisted: vi.fn().mockResolvedValue(false) }))
vi.mock("@/lib/mtn-providers/factory", () => ({
  getMTNProvider: vi.fn().mockResolvedValue({ name: "hubnet" }),
  getProviderNameForNetwork: vi.fn(),
}))
const holdMtnOrder = vi.hoisted(() => vi.fn().mockResolvedValue({ held: true }))
vi.mock("@/lib/mtn-hold", () => ({ holdMtnOrder }))
const holdOutcomeUnknown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock("@/lib/mtn-providers/outcome-hold", () => ({
  holdOutcomeUnknown,
  isOutcomeUnknown: (r: any) => r?.error_type === "OUTCOME_UNKNOWN",
}))

import { processManualFulfillment } from "./fulfillment-service"

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("processManualFulfillment — strict supplier verification", () => {
  beforeEach(() => {
    updates.length = 0
    tracking.rows = []
    vi.clearAllMocks()
  })

  for (const [errorType, message] of [
    ["SUPPLIER_NOT_APPROVED", "Hubnet hasn't approved this number"],
    ["SUPPLIER_CHECK_UNAVAILABLE", "Hubnet couldn't check this number right now"],
  ] as const) {
    it(`${errorType}: back to pending, message returned, no tracking, no alert, no retry bump`, async () => {
      tracking.rows = [{ id: "trk-1", mtn_order_id: "FAILED_INIT_1", status: "failed", retry_count: 2, provider: "agentportalgh" }]
      createMTNOrder.mockResolvedValue({ success: false, message, error_type: errorType })
      const r = await processManualFulfillment("order-uuid-1", "shop", "hubnet")
      await flush()
      expect(r).toEqual({ success: false, message, orderId: "order-uuid-1" })
      const orderUpdates = updates.filter((u) => u.table === "shop_orders" && u.patch)
      expect(orderUpdates.map((u) => u.patch.order_status)).toEqual(["processing", "pending"])
      expect(updates.some((u) => u.table === "mtn_fulfillment_tracking")).toBe(false)
      expect(updates.some((u) => u.table === "fulfillment_logs")).toBe(false)
      expect(saveMTNTracking).not.toHaveBeenCalled()
      expect(notifyAdmins).not.toHaveBeenCalled()
      expect(notifyAdminsPush).not.toHaveBeenCalled()
      expect(holdMtnOrder).not.toHaveBeenCalled()
      expect(holdOutcomeUnknown).not.toHaveBeenCalled()
      // pinned: the explicit provider was passed straight through
      expect(createMTNOrder.mock.calls[0][0].provider).toBe("hubnet")
    })
  }

  it("STRICT_HOLD: strict hold with the reason, no tracking, no alert", async () => {
    createMTNOrder.mockResolvedValue({ success: false, held: true, message: "held", error_type: "STRICT_HOLD", strictHoldReason: "unanswered" })
    const r = await processManualFulfillment("order-uuid-1", "shop")
    await flush()
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/^Held: /)
    expect(holdMtnOrder).toHaveBeenCalledWith({
      table: "shop_orders", orderId: "order-uuid-1", phone: "0551234567", errorType: "STRICT_HOLD", strictReason: "unanswered",
    })
    expect(saveMTNTracking).not.toHaveBeenCalled()
    expect(notifyAdmins).not.toHaveBeenCalled()
  })

  it("registration hold passes its errorType through", async () => {
    createMTNOrder.mockResolvedValue({ success: false, held: true, message: "held", error_type: "NUMBER_NOT_REGISTERED" })
    await processManualFulfillment("order-uuid-1", "shop")
    expect(holdMtnOrder.mock.calls[0][0]).toMatchObject({ errorType: "NUMBER_NOT_REGISTERED" })
  })
})
