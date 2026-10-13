import { describe, expect, it, vi } from "vitest"
import { makeOrderHook } from "./order-hook"
import { makeTx } from "./testing/fixtures"

const deps = (over: any = {}) => ({
  store: { markOrderSynced: vi.fn(async () => {}) },
  notify: vi.fn(async () => "synced" as const),
  alertReview: vi.fn(async () => {}),
  ...over,
})

describe("makeOrderHook", () => {
  it("marks the row synced only when the adapter succeeded", async () => {
    const d = deps()
    await makeOrderHook(d)(makeTx({ id: "a", state: "fulfilled", order_table: "airtime_orders", order_id: "o1" }))
    expect(d.notify).toHaveBeenCalledTimes(1)
    expect(d.store.markOrderSynced).toHaveBeenCalledWith("a")
  })
  it("does not mark synced when the adapter failed or is missing", async () => {
    for (const r of ["failed", "no_adapter", "no_order", "not_terminal"] as const) {
      const d = deps({ notify: vi.fn(async () => r) })
      await makeOrderHook(d)(makeTx({ state: "failed", order_table: "airtime_orders", order_id: "o1" }))
      expect(d.store.markOrderSynced).not.toHaveBeenCalled()
    }
  })
  it("alerts (and does not notify) when a row enters needs_review", async () => {
    const d = deps()
    await makeOrderHook(d)(makeTx({ state: "needs_review" }))
    expect(d.alertReview).toHaveBeenCalledTimes(1)
    expect(d.notify).not.toHaveBeenCalled()
  })
  it("never throws", async () => {
    const d = deps({ notify: vi.fn(async () => { throw new Error("x") }), store: { markOrderSynced: vi.fn(async () => { throw new Error("y") }) } })
    await expect(makeOrderHook(d)(makeTx({ state: "fulfilled" }))).resolves.toBeUndefined()
    const d2 = deps({ alertReview: vi.fn(async () => { throw new Error("z") }) })
    await expect(makeOrderHook(d2)(makeTx({ state: "needs_review" }))).resolves.toBeUndefined()
  })
})
