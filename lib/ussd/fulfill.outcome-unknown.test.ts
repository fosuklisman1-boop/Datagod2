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

import { fulfillUssdOrder } from "./fulfill"

describe("fulfillUssdOrder — OUTCOME_UNKNOWN", () => {
  beforeEach(() => {
    updates.length = 0
    vi.clearAllMocks()
  })

  it("keeps the order processing, saves UNKNOWN_ tracking and alerts once", async () => {
    createMTNOrder.mockResolvedValue({
      success: false,
      message: "Apex Prime returned an unreadable response (HTTP 500) — the order may have been created. Check the Apex Prime dashboard before retrying.",
      error_type: "OUTCOME_UNKNOWN",
      provider: "apexprime",
    })
    const r = await fulfillUssdOrder("order-uuid-1", "MTN", "0551234567", "1GB")
    expect(r.success).toBe(false)
    expect(r.message).toContain("Check the Apex Prime dashboard")
    expect(updates.every((u) => u.patch.order_status === "processing")).toBe(true)
    expect(updates.some((u) => u.patch.order_status === "pending")).toBe(false)
    expect(saveMTNTracking).toHaveBeenCalledTimes(1)
    expect(String(saveMTNTracking.mock.calls[0][1])).toMatch(/^UNKNOWN_\d+$/)
    expect(notifyAdmins).toHaveBeenCalledTimes(1)
    expect(notifyAdmins.mock.calls[0][1]).toBe("provider_outcome_unknown")
    expect(notifyAdmins.mock.calls[0][0]).not.toMatch(/0551234567/)
  })

  it("ordinary failure is unchanged: pending + FAILED_INIT_, no outcome alert", async () => {
    createMTNOrder.mockResolvedValue({ success: false, message: "insufficient balance", error_type: "API_ERROR", provider: "sykes" })
    await fulfillUssdOrder("order-uuid-2", "MTN", "0551234567", "1GB")
    expect(updates.some((u) => u.patch.order_status === "pending")).toBe(true)
    expect(String(saveMTNTracking.mock.calls[0][1])).toMatch(/^FAILED_INIT_/)
    expect(notifyAdmins).not.toHaveBeenCalled()
  })
})
