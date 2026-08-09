import { describe, it, expect, vi } from "vitest"
import { isReversal, flagReversal, fetchReversalCandidates, looksProviderCompleted, REVERSAL_WINDOW_MS } from "./mtn-reversal"

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

describe("looksProviderCompleted", () => {
  it("accepts common provider completion keywords", () => {
    for (const s of ["completed", "Complete", "SUCCESS", "successful", "Delivered", "done", "sent", "fulfilled"]) {
      expect(looksProviderCompleted(s)).toBe(true)
    }
  })
  it("rejects a genuine provider failure string", () => {
    expect(looksProviderCompleted("failed")).toBe(false)
  })
  it("rejects null/undefined/empty (row whose external_status was never set by a real provider check)", () => {
    expect(looksProviderCompleted(null)).toBe(false)
    expect(looksProviderCompleted(undefined)).toBe(false)
    expect(looksProviderCompleted("")).toBe(false)
  })
})

describe("fetchReversalCandidates", () => {
  // Regression test for: admin bulk-completes a manually-downloaded batch of
  // orders whose Sykes attempt genuinely failed. bulk-update-status (and the
  // sync cron's own reconcile-against-terminal step) flips
  // mtn_fulfillment_tracking.status to "completed" but never touches
  // external_status, since neither ever asked Sykes. Before this fix, the
  // next cron run would find that row via fetchReversalCandidates, see
  // Sykes still reporting "failed", and wrongly flag/reverse the order the
  // admin had just legitimately completed.
  function makeFake(rows: any[]) {
    const fake: any = {
      from() {
        return {
          select() {
            return {
              eq() { return this },
              gte() { return this },
              not() { return this },
              order() { return this },
              limit: () => Promise.resolve({ data: rows }),
            }
          },
        }
      },
    }
    return fake
  }

  it("excludes a row bulk-completed by an admin (external_status still the real Sykes failure)", async () => {
    const fake = makeFake([
      { id: "trk1", mtn_order_id: 1, provider: "sykes", status: "completed", external_status: "failed", updated_at: new Date().toISOString() },
    ])
    const rows = await fetchReversalCandidates(fake, "sykes")
    expect(rows).toEqual([])
  })

  it("excludes a row whose external_status was never set (reconciled, never asked the provider)", async () => {
    const fake = makeFake([
      { id: "trk2", mtn_order_id: 2, provider: "sykes", status: "completed", external_status: null, updated_at: new Date().toISOString() },
    ])
    const rows = await fetchReversalCandidates(fake, "sykes")
    expect(rows).toEqual([])
  })

  it("includes a row the provider itself genuinely confirmed completed", async () => {
    const fake = makeFake([
      { id: "trk3", mtn_order_id: 3, provider: "sykes", status: "completed", external_status: "delivered", updated_at: new Date().toISOString() },
    ])
    const rows = await fetchReversalCandidates(fake, "sykes")
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe("trk3")
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
