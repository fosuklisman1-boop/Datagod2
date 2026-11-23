// The strict re-check claims a held USSD order straight to `processing` and then calls fulfillUssdOrder.
// Every exit of fulfillUssdOrder must leave a sane status when it starts from `processing`.
import { describe, it, expect, vi, beforeEach } from "vitest"

const store = vi.hoisted(() => ({ status: "processing" as string }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      update: (patch: any) => ({
        eq: (_c: string, _id: string) => {
          const apply = (allowed?: string[]) => {
            if (!allowed || allowed.includes(store.status)) store.status = patch.order_status
            return { error: null }
          }
          return {
            then: (res: any, rej: any) => Promise.resolve(apply()).then(res, rej),
            in: async (_col: string, vals: string[]) => apply(vals),
          }
        },
      }),
    }),
  }),
}))

const createMTNOrder = vi.hoisted(() => vi.fn())
const isAuto = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock("@/lib/mtn-fulfillment", () => ({
  isAutoFulfillmentEnabled: isAuto,
  createMTNOrder,
  saveMTNTracking: vi.fn().mockResolvedValue("t"),
  normalizePhoneNumber: (p: string) => p,
}))
const blacklisted = vi.hoisted(() => vi.fn().mockResolvedValue(false))
vi.mock("@/lib/blacklist", () => ({ isPhoneBlacklisted: blacklisted }))
vi.mock("@/lib/sms-service", () => ({ notifyAdmins: vi.fn().mockResolvedValue(undefined) }))
const holdMtnOrder = vi.hoisted(() => vi.fn())
vi.mock("@/lib/mtn-hold", () => ({ holdMtnOrder }))

import { fulfillUssdOrder } from "./fulfill"

const run = (provider?: string) => fulfillUssdOrder("u1", "MTN", "0559000201", "1GB", false, "ussd_orders", provider)

describe("fulfillUssdOrder starting from processing (strict re-check release)", () => {
  beforeEach(() => {
    store.status = "processing"
    vi.clearAllMocks()
    isAuto.mockResolvedValue(true)
    blacklisted.mockResolvedValue(false)
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("success: stays processing (awaiting the status cron)", async () => {
    createMTNOrder.mockResolvedValue({ success: true, order_id: "x1", provider: "sykes" })
    expect((await run()).success).toBe(true)
    expect(store.status).toBe("processing")
  })

  it("normal failure: back to pending for the manual queue", async () => {
    createMTNOrder.mockResolvedValue({ success: false, message: "no balance", error_type: "API_ERROR", provider: "sykes" })
    expect((await run()).success).toBe(false)
    expect(store.status).toBe("pending")
  })

  it("STRICT_HOLD: holdMtnOrder is called (it accepts processing); fulfill itself changes nothing", async () => {
    createMTNOrder.mockResolvedValue({ success: false, held: true, message: "held", error_type: "STRICT_HOLD", strictHoldReason: "rejected" })
    const r = await run()
    expect(r.held).toBe(true)
    expect(holdMtnOrder).toHaveBeenCalledTimes(1)
    expect(store.status).toBe("processing")
  })

  it("pinned-supplier refusal: processing is reverted to pending", async () => {
    createMTNOrder.mockResolvedValue({ success: false, message: "not approved", error_type: "SUPPLIER_NOT_APPROVED" })
    await run("hubnet")
    expect(store.status).toBe("pending")
  })

  it("OUTCOME_UNKNOWN: stays processing, never re-fulfillable", async () => {
    createMTNOrder.mockResolvedValue({ success: false, message: "may exist", error_type: "OUTCOME_UNKNOWN", provider: "apexprime" })
    await run()
    expect(store.status).toBe("processing")
  })

  it("auto-fulfilment off: pending for the manual queue", async () => {
    isAuto.mockResolvedValue(false)
    expect((await run()).success).toBe(true)
    expect(store.status).toBe("pending")
  })

  it("blacklisted recipient: failed", async () => {
    blacklisted.mockResolvedValue(true)
    expect((await run()).success).toBe(false)
    expect(store.status).toBe("failed")
  })
})
