import { describe, it, expect, vi, beforeEach } from "vitest"

const updates = vi.hoisted(() => [] as any[])
const orderNetwork = vi.hoisted(() => ({ current: "MTN" }))
const createNonMTNOrder = vi.hoisted(() => vi.fn())
vi.mock("@/lib/non-mtn-fulfillment", () => ({ createNonMTNOrder }))

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
          data: { id: "order-uuid-1", network: orderNetwork.current, volume_gb: 1, customer_phone: "0551234567", customer_name: "x", order_status: "pending", queue: null },
          error: null,
        }),
      then: (resolve: any) => {
        if (mode === "update") updates.push({ table, patch })
        // atomic lock + tracking lookups: one row / no rows
        resolve({ data: mode === "update" ? [{ id: "order-uuid-1" }] : [], error: null })
      },
    }
    return c
  }
  return {
    createClient: () => ({
      from: (table: string) => ({
        select: () => chain(table, "select"),
        update: (patch: any) => chain(table, "update", patch),
      }),
    }),
  }
})

const createMTNOrder = vi.hoisted(() => vi.fn())
const saveMTNTracking = vi.hoisted(() => vi.fn().mockResolvedValue("t"))
vi.mock("@/lib/mtn-fulfillment", () => ({
  createMTNOrder,
  saveMTNTracking,
  checkMTNOrderStatus: vi.fn(),
}))
const notifyAdmins = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: vi.fn().mockResolvedValue(undefined),
  notifyAdmins,
  SMSTemplates: { fulfillmentFailed: () => "failed", orderPaymentConfirmed: () => "ok" },
}))
vi.mock("@/lib/blacklist", () => ({ isPhoneBlacklisted: vi.fn().mockResolvedValue(false) }))
vi.mock("@/lib/mtn-providers/factory", () => ({
  getMTNProvider: vi.fn().mockResolvedValue({ name: "apexprime" }),
  getProviderNameForNetwork: vi.fn(),
}))

import { processManualFulfillment } from "./fulfillment-service"

describe("processManualFulfillment — OUTCOME_UNKNOWN", () => {
  beforeEach(() => {
    updates.length = 0
    orderNetwork.current = "MTN"
    vi.clearAllMocks()
  })

  it("non-MTN branch: outcomeUnknown keeps the order processing, no pending revert, no failure alert", async () => {
    orderNetwork.current = "Telecel"
    createNonMTNOrder.mockResolvedValue({
      success: false,
      outcomeUnknown: true,
      provider: "xpress",
      message: "Xpress returned an unreadable response (HTTP 500) — the order may have been created. Check the Xpress dashboard before retrying.",
    })
    const r = await processManualFulfillment("order-uuid-1", "shop")
    expect(r.success).toBe(false)
    expect(r.message).toContain("Check the Xpress dashboard")
    expect(updates.some((u) => u.patch.order_status === "pending")).toBe(false)
    expect(notifyAdmins).not.toHaveBeenCalled()
  })

  it("leaves the order processing (never pending), saves UNKNOWN_ tracking, alerts once", async () => {
    createMTNOrder.mockResolvedValue({
      success: false,
      message: "Apex Prime returned an unreadable response (HTTP 500) — the order may have been created. Check the Apex Prime dashboard before retrying.",
      error_type: "OUTCOME_UNKNOWN",
      provider: "apexprime",
    })
    const r = await processManualFulfillment("order-uuid-1", "shop")
    expect(r.success).toBe(false)
    expect(r.message).toContain("Check the Apex Prime dashboard before retrying")
    expect(updates.some((u) => u.patch.order_status === "pending")).toBe(false)
    expect(saveMTNTracking).toHaveBeenCalledTimes(1)
    expect(String(saveMTNTracking.mock.calls[0][1])).toMatch(/^UNKNOWN_\d+$/)
    expect(notifyAdmins).toHaveBeenCalledTimes(1)
    expect(notifyAdmins.mock.calls[0][1]).toBe("provider_outcome_unknown")
    expect(notifyAdmins.mock.calls[0][0]).not.toMatch(/0551234567/)
  })

  it("ordinary failure unchanged: reverts to pending with FAILED_INIT_", async () => {
    createMTNOrder.mockResolvedValue({ success: false, message: "insufficient balance", error_type: "API_ERROR", provider: "apexprime" })
    await processManualFulfillment("order-uuid-1", "shop", undefined, true)
    expect(updates.some((u) => u.patch.order_status === "pending")).toBe(true)
    expect(String(saveMTNTracking.mock.calls[0][1])).toMatch(/^FAILED_INIT_/)
    expect(notifyAdmins).not.toHaveBeenCalled()
  })
})
