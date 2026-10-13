import { afterEach, describe, expect, it, vi } from "vitest"
import { clearOrderAdapters, getOrderAdapter, notifyAdapter, registerOrderAdapter } from "./adapters"
import { makeTx } from "./testing/fixtures"

afterEach(() => clearOrderAdapters())

const adapter = () => ({ table: "airtime_orders", onFulfilled: vi.fn(async () => {}), onFailed: vi.fn(async () => {}) })

describe("order adapters", () => {
  it("routes fulfilled and failed rows to the adapter for their order_table", async () => {
    const a = adapter(); registerOrderAdapter(a)
    await notifyAdapter(makeTx({ state: "fulfilled", order_table: "airtime_orders", order_id: "o1" }))
    await notifyAdapter(makeTx({ state: "failed", order_table: "airtime_orders", order_id: "o2" }))
    expect(a.onFulfilled).toHaveBeenCalledTimes(1)
    expect(a.onFailed).toHaveBeenCalledTimes(1)
  })
  it("does nothing for unlinked rows, unknown tables or non-terminal states", async () => {
    const a = adapter(); registerOrderAdapter(a)
    await notifyAdapter(makeTx({ state: "fulfilled", order_table: null }))
    await notifyAdapter(makeTx({ state: "fulfilled", order_table: "other_orders", order_id: "o" }))
    await notifyAdapter(makeTx({ state: "pending", order_table: "airtime_orders", order_id: "o" }))
    expect(a.onFulfilled).not.toHaveBeenCalled()
  })
  it("never throws when an adapter hook throws", async () => {
    const a = { ...adapter(), onFulfilled: vi.fn(async () => { throw new Error("db down") }) }
    registerOrderAdapter(a)
    await expect(notifyAdapter(makeTx({ state: "fulfilled", order_table: "airtime_orders", order_id: "o" }))).resolves.toBeUndefined()
  })
  it("getOrderAdapter looks up by table", () => {
    const a = adapter(); registerOrderAdapter(a)
    expect(getOrderAdapter("airtime_orders")).toBe(a)
    expect(getOrderAdapter(null)).toBeUndefined()
    expect(getOrderAdapter("nope")).toBeUndefined()
  })
})
