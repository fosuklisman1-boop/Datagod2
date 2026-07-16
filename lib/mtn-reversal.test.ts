import { describe, it, expect, vi } from "vitest"
import { isReversal, flagReversal, REVERSAL_WINDOW_MS } from "./mtn-reversal"

vi.mock("@/lib/push-service", () => ({ notifyAdminsPush: vi.fn().mockResolvedValue(undefined) }))

const now = new Date("2026-07-16T12:00:00Z")

describe("isReversal", () => {
  it("flags a completed row now reported failed, within window", () => {
    expect(isReversal({ trackingStatus: "completed", completedAt: "2026-07-16T06:00:00Z", providerStatus: "failed", now })).toBe(true)
  })
  it("ignores when provider still completed", () => {
    expect(isReversal({ trackingStatus: "completed", completedAt: "2026-07-16T06:00:00Z", providerStatus: "completed", now })).toBe(false)
  })
  it("ignores when the row is not completed", () => {
    expect(isReversal({ trackingStatus: "processing", completedAt: "2026-07-16T06:00:00Z", providerStatus: "failed", now })).toBe(false)
  })
  it("ignores completions older than the window", () => {
    const old = new Date(now.getTime() - REVERSAL_WINDOW_MS - 1000).toISOString()
    expect(isReversal({ trackingStatus: "completed", completedAt: old, providerStatus: "failed", now })).toBe(false)
  })
})

describe("flagReversal", () => {
  it("sets tracking + shop order to reversed and returns flagged", async () => {
    const updates: any[] = []
    const fake: any = {
      from(table: string) {
        return {
          update(vals: any) { updates.push({ table, vals }); return { eq: () => Promise.resolve({ error: null }) } },
        }
      },
    }
    const row = { id: "trk1", order_type: "shop", order_id: null, shop_order_id: "shop1", api_order_id: null, provider: "sykes" }
    const res = await flagReversal(fake, row, { status: "failed", message: "reversed by provider" })
    expect(res.flagged).toBe(true)
    expect(updates).toContainEqual(expect.objectContaining({ table: "mtn_fulfillment_tracking", vals: expect.objectContaining({ status: "reversed" }) }))
    expect(updates).toContainEqual(expect.objectContaining({ table: "shop_orders", vals: expect.objectContaining({ order_status: "reversed" }) }))
  })
})
