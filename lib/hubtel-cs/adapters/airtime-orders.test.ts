import { describe, expect, it, vi } from "vitest"
import { AIRTIME_ORDERS_TABLE, createAirtimeOrdersAdapter } from "./airtime-orders"
import { makeTx } from "../testing/fixtures"

describe("airtime_orders adapter", () => {
  it("owns airtime_orders", () => {
    expect(createAirtimeOrdersAdapter({ update: async () => {}, alert: async () => {} }).table).toBe(AIRTIME_ORDERS_TABLE)
  })
  it("fulfilled -> completed with the Hubtel references in the note", async () => {
    const update = vi.fn(async () => {})
    await createAirtimeOrdersAdapter({ update, alert: async () => {} })
      .onFulfilled(makeTx({ order_id: "o1", client_reference: "HCS-1", hubtel_transaction_id: "T9" }))
    expect(update).toHaveBeenCalledWith("o1", { status: "completed", notes: expect.stringMatching(/HCS-1.*T9|T9.*HCS-1/) })
  })
  it("failed -> back to pending for manual fulfilment (existing Digiwapy convention) + alert", async () => {
    const update = vi.fn(async () => {}), alert = vi.fn(async () => {})
    await createAirtimeOrdersAdapter({ update, alert })
      .onFailed(makeTx({ order_id: "o1", client_reference: "HCS-1", failure_reason: "Invalid number" }))
    expect(update).toHaveBeenCalledWith("o1", { status: "pending", notes: expect.stringContaining("Invalid number") })
    expect(alert).toHaveBeenCalledTimes(1)
  })
  it("has no refundToWallet (airtime refunds use /admin/refunds)", () => {
    expect(createAirtimeOrdersAdapter({ update: async () => {}, alert: async () => {} }).refundToWallet).toBeUndefined()
  })
  it("propagates update errors so the hook is retried by the re-notify sweep", async () => {
    const a = createAirtimeOrdersAdapter({ update: async () => { throw new Error("db") }, alert: async () => {} })
    await expect(a.onFulfilled(makeTx({ order_id: "o1" }))).rejects.toThrow("db")
  })
})
