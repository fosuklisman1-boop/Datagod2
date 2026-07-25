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
  // siblingRows: rows returned by the "any other tracking row for this order
  // already completed?" lookup — [] means no sibling (normal reversal path).
  function makeFake(siblingRows: any[] = []) {
    const updates: any[] = []
    const fake: any = {
      from(table: string) {
        return {
          update(vals: any) { updates.push({ table, vals }); return { eq: () => Promise.resolve({ error: null }) } },
          select() {
            return {
              eq() {
                return {
                  neq() {
                    return {
                      eq() {
                        return { limit: () => Promise.resolve({ data: siblingRows }) }
                      },
                    }
                  },
                }
              },
            }
          },
        }
      },
    }
    return { fake, updates }
  }

  it("sets tracking + shop order to reversed and returns flagged (no sibling row)", async () => {
    const { fake, updates } = makeFake([])
    const row = { id: "trk1", order_type: "shop", order_id: null, shop_order_id: "shop1", api_order_id: null, provider: "sykes" }
    const res = await flagReversal(fake, row, { status: "failed", message: "reversed by provider" })
    expect(res.flagged).toBe(true)
    expect(res.superseded).toBe(false)
    expect(updates).toContainEqual(expect.objectContaining({ table: "mtn_fulfillment_tracking", vals: expect.objectContaining({ status: "reversed" }) }))
    expect(updates).toContainEqual(expect.objectContaining({ table: "shop_orders", vals: expect.objectContaining({ order_status: "reversed" }) }))
  })

  it("routes a legacy null-order_type row (order_id only) to the orders table", async () => {
    const { fake, updates } = makeFake([])
    const row = { id: "trk2", order_type: null, order_id: "bulk1", shop_order_id: null, api_order_id: null, provider: "sykes" }
    const res = await flagReversal(fake, row, { status: "failed" })
    expect(res.flagged).toBe(true)
    expect(updates).toContainEqual(expect.objectContaining({ table: "orders", vals: expect.objectContaining({ status: "reversed" }) }))
  })

  it("does NOT touch the shared order when a newer tracking row already shows completed (stale/superseded)", async () => {
    const { fake, updates } = makeFake([{ id: "trk-newer" }])
    const row = { id: "trk1", order_type: "shop", order_id: null, shop_order_id: "shop1", api_order_id: null, provider: "xpress" }
    const res = await flagReversal(fake, row, { status: "failed" })
    expect(res.flagged).toBe(true)
    expect(res.superseded).toBe(true)
    // The stale row itself is still marked reversed for audit accuracy...
    expect(updates).toContainEqual(expect.objectContaining({ table: "mtn_fulfillment_tracking", vals: expect.objectContaining({ status: "reversed" }) }))
    // ...but the shared order must NOT be touched, since a newer delivery already succeeded.
    expect(updates.find(u => u.table === "shop_orders")).toBeUndefined()
  })
})
