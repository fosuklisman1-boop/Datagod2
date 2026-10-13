import { describe, expect, it, vi } from "vitest"
import { AIRTIME_ORDERS_TABLE, createAirtimeOrdersAdapter } from "./airtime-orders"
import { makeTx } from "../testing/fixtures"

const LIVE = ["pending", "processing"]
const base = () => ({ update: async () => 1, get: async () => ({ status: "pending", notes: null as string | null }) as { status: string; notes: string | null } | null, getStatus: async () => "processing" as string | null, alert: async () => {} })

describe("airtime_orders adapter", () => {
  it("owns airtime_orders", () => {
    expect(createAirtimeOrdersAdapter(base()).table).toBe(AIRTIME_ORDERS_TABLE)
  })
  it("fulfilled -> completed with the Hubtel references in the note", async () => {
    const update = vi.fn(async () => 1)
    await createAirtimeOrdersAdapter({ ...base(), update })
      .onFulfilled(makeTx({ order_id: "o1", client_reference: "HCS-1", hubtel_transaction_id: "T9" }))
    expect(update).toHaveBeenCalledWith("o1", { status: "completed", notes: expect.stringMatching(/HCS-1.*T9|T9.*HCS-1/) }, LIVE)
  })
  it("failed -> back to pending for manual fulfilment (existing Digiwapy convention) + alert", async () => {
    const update = vi.fn(async () => 1), alert = vi.fn(async () => {})
    await createAirtimeOrdersAdapter({ ...base(), update, alert })
      .onFailed(makeTx({ order_id: "o1", client_reference: "HCS-1", failure_reason: "Invalid number" }))
    expect(update).toHaveBeenCalledWith("o1", { status: "pending", notes: expect.stringContaining("Invalid number") }, ["pending"])
    expect(alert).toHaveBeenCalledTimes(1)
  })
  it("has no refundToWallet (airtime refunds use /admin/refunds)", () => {
    expect(createAirtimeOrdersAdapter(base()).refundToWallet).toBeUndefined()
  })
  it("propagates update errors so the hook is retried by the re-notify sweep", async () => {
    const a = createAirtimeOrdersAdapter({ ...base(), update: async () => { throw new Error("db") } })
    await expect(a.onFulfilled(makeTx({ order_id: "o1" }))).rejects.toThrow("db")
    await expect(a.onFailed(makeTx({ order_id: "o1" }))).rejects.toThrow("db")
  })
  it("onFailed on an already-failed (refunded) order: no status change, no alert", async () => {
    const alert = vi.fn(async () => {})
    await createAirtimeOrdersAdapter({ ...base(), update: async () => 0, getStatus: async () => "failed", alert })
      .onFailed(makeTx({ order_id: "o1", failure_reason: "x" }))
    expect(alert).not.toHaveBeenCalled()
  })
  it("onFailed from processing -> pending and alerts exactly once", async () => {
    const alert = vi.fn(async () => {})
    await createAirtimeOrdersAdapter({ ...base(), alert }).onFailed(makeTx({ order_id: "o1", failure_reason: "x" }))
    expect(alert).toHaveBeenCalledTimes(1)
  })
  it("onFailed replay: order now processing under another provider (Digiwapy note) -> untouched, no alert", async () => {
    const update = vi.fn(async () => 1), alert = vi.fn(async () => {})
    await createAirtimeOrdersAdapter({ ...base(), update, alert, get: async () => ({ status: "processing", notes: "Sent via Digiwapy [ref:D1]" }) })
      .onFailed(makeTx({ order_id: "o1", client_reference: "HCS-1", failure_reason: "x" }))
    expect(update).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })
  it("onFailed: processing with our hcsRef -> pending (compare-and-set on processing) + alert", async () => {
    const update = vi.fn(async () => 1), alert = vi.fn(async () => {})
    await createAirtimeOrdersAdapter({ ...base(), update, alert, get: async () => ({ status: "processing", notes: "Sent via Hubtel [hcsRef:HCS-1]" }) })
      .onFailed(makeTx({ order_id: "o1", client_reference: "HCS-1", failure_reason: "x" }))
    expect(update).toHaveBeenCalledWith("o1", expect.objectContaining({ status: "pending" }), ["processing"])
    expect(alert).toHaveBeenCalledTimes(1)
  })
  it("onFailed: pending -> pending (compare-and-set on pending) + alert", async () => {
    const update = vi.fn(async () => 1), alert = vi.fn(async () => {})
    await createAirtimeOrdersAdapter({ ...base(), update, alert, get: async () => ({ status: "pending", notes: null }) })
      .onFailed(makeTx({ order_id: "o1", client_reference: "HCS-1", failure_reason: "x" }))
    expect(update).toHaveBeenCalledWith("o1", expect.objectContaining({ status: "pending" }), ["pending"])
    expect(alert).toHaveBeenCalledTimes(1)
  })
  it("onFailed: compare-and-set matches 0 rows -> no alert", async () => {
    const alert = vi.fn(async () => {})
    await createAirtimeOrdersAdapter({ ...base(), update: async () => 0, alert, get: async () => ({ status: "pending", notes: null }) })
      .onFailed(makeTx({ order_id: "o1", failure_reason: "x" }))
    expect(alert).not.toHaveBeenCalled()
  })
  it("onFailed: get throws -> rejects so the sweep retries", async () => {
    const a = createAirtimeOrdersAdapter({ ...base(), get: async () => { throw new Error("db") } })
    await expect(a.onFailed(makeTx({ order_id: "o1" }))).rejects.toThrow("db")
  })
  it("onFulfilled on a failed/refunded order: no write applied, double-value alert", async () => {
    const alert = vi.fn(async () => {})
    const update = vi.fn(async () => 0)
    await createAirtimeOrdersAdapter({ ...base(), update, getStatus: async () => "failed", alert })
      .onFulfilled(makeTx({ order_id: "o1", client_reference: "HCS-1" }))
    expect(update).toHaveBeenCalledWith("o1", expect.objectContaining({ status: "completed" }), LIVE)
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledWith(expect.stringMatching(/double value/))
  })
  it("onFulfilled with 0 rows on an already-completed order: no alert", async () => {
    const alert = vi.fn(async () => {})
    await createAirtimeOrdersAdapter({ ...base(), update: async () => 0, getStatus: async () => "completed", alert })
      .onFulfilled(makeTx({ order_id: "o1" }))
    expect(alert).not.toHaveBeenCalled()
  })
  it("onFulfilled from processing -> completed without alert", async () => {
    const alert = vi.fn(async () => {})
    await createAirtimeOrdersAdapter({ ...base(), alert }).onFulfilled(makeTx({ order_id: "o1" }))
    expect(alert).not.toHaveBeenCalled()
  })
})
