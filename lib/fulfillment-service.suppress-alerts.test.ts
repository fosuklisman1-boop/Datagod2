import { describe, it, expect, vi, beforeEach } from "vitest"

const orderNetwork = vi.hoisted(() => ({ current: "MTN" }))
const createNonMTNOrder = vi.hoisted(() => vi.fn())
vi.mock("@/lib/non-mtn-fulfillment", () => ({ createNonMTNOrder }))

vi.mock("@supabase/supabase-js", () => {
  function chain(mode: "select" | "update") {
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
      // atomic lock: one row; tracking lookup: no rows
      then: (resolve: any) => resolve({ data: mode === "update" ? [{ id: "order-uuid-1" }] : [], error: null }),
    }
    return c
  }
  return {
    createClient: () => ({
      from: () => ({ select: () => chain("select"), update: () => chain("update") }),
    }),
  }
})

const createMTNOrder = vi.hoisted(() => vi.fn())
vi.mock("@/lib/mtn-fulfillment", () => ({
  createMTNOrder,
  saveMTNTracking: vi.fn().mockResolvedValue("t"),
  checkMTNOrderStatus: vi.fn(),
}))
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
  getMTNProvider: vi.fn().mockResolvedValue({ name: "apexprime" }),
  getProviderNameForNetwork: vi.fn().mockResolvedValue("xpress"),
}))

import { processManualFulfillment } from "./fulfillment-service"

// The alerts are fire-and-forget dynamic imports; let them settle before asserting.
const settle = () => new Promise((r) => setTimeout(r, 20))

describe("processManualFulfillment — suppressFailureAlerts", () => {
  beforeEach(() => {
    orderNetwork.current = "MTN"
    vi.clearAllMocks()
  })

  it("processManualFulfillment with suppressFailureAlerts sends neither notifyAdmins nor notifyAdminsPush on failure (non-MTN)", async () => {
    orderNetwork.current = "Telecel"
    createNonMTNOrder.mockResolvedValue({ success: false, provider: "xpress", message: "Rate limit exceeded" })
    const r = await processManualFulfillment("order-uuid-1", "shop", undefined, false, { suppressFailureAlerts: true })
    await settle()
    expect(r).toMatchObject({ success: false, message: "Rate limit exceeded" })
    expect(notifyAdmins).not.toHaveBeenCalled()
    expect(notifyAdminsPush).not.toHaveBeenCalled()
  })

  it("processManualFulfillment with suppressFailureAlerts sends no admin SMS on an MTN failure", async () => {
    createMTNOrder.mockResolvedValue({ success: false, message: "Rate limit exceeded", error_type: "API_ERROR", provider: "apexprime" })
    const r = await processManualFulfillment("order-uuid-1", "shop", undefined, false, { suppressFailureAlerts: true })
    await settle()
    expect(r.success).toBe(false)
    expect(notifyAdmins).not.toHaveBeenCalled()
    expect(notifyAdminsPush).not.toHaveBeenCalled()
  })

  it("without the option the failure alerts still go out (unchanged)", async () => {
    orderNetwork.current = "Telecel"
    createNonMTNOrder.mockResolvedValue({ success: false, provider: "xpress", message: "Rate limit exceeded" })
    await processManualFulfillment("order-uuid-1", "shop")
    await settle()
    expect(notifyAdmins).toHaveBeenCalledTimes(1)
    expect(notifyAdminsPush).toHaveBeenCalledTimes(1)
  })

  it("skipSms alone still sends the push (unchanged)", async () => {
    orderNetwork.current = "Telecel"
    createNonMTNOrder.mockResolvedValue({ success: false, provider: "xpress", message: "Rate limit exceeded" })
    await processManualFulfillment("order-uuid-1", "shop", undefined, true)
    await settle()
    expect(notifyAdmins).not.toHaveBeenCalled()
    expect(notifyAdminsPush).toHaveBeenCalledTimes(1)
  })
})
