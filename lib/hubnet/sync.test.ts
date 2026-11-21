import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => {}) }))

import { applyHubnetStatusChange, type HubnetSyncRow } from "./sync"

type Call = { table: string; op: string; payload?: any; filters: Array<[string, any]> }

function makeDb(trackingRows: any[], mirrorRow: any = { user_id: "user-1" }) {
  const calls: Call[] = []
  function from(table: string) {
    const call: Call = { table, op: "select", filters: [] }
    calls.push(call)
    const result = () => {
      if (table === "mtn_fulfillment_tracking" && call.op === "update") return { data: trackingRows, error: null }
      if (table === "orders" && call.op === "update") return { data: mirrorRow, error: null }
      return { data: null, error: null }
    }
    const b: any = {
      select: () => b,
      update: (p: any) => ((call.op = "update"), (call.payload = p), b),
      insert: (p: any) => ((call.op = "insert"), (call.payload = p), Promise.resolve({ error: null })),
      eq: (c: string, v: any) => (call.filters.push([c, v]), b),
      single: () => Promise.resolve(result()),
      then: (res: any, rej: any) => Promise.resolve(result()).then(res, rej),
    }
    return b
  }
  return { db: { from } as any, calls }
}

const row = (over: Partial<HubnetSyncRow> = {}): HubnetSyncRow => ({
  id: "t1",
  mtn_order_id: "DGabc",
  status: "processing",
  shop_order_id: null,
  order_id: "o1",
  api_order_id: null,
  order_type: "bulk",
  size_gb: 2,
  ...over,
})

const res = (status: string, raw = "success") => ({ success: true, status, message: "Hubnet status", order: { status: raw } })

describe("applyHubnetStatusChange", () => {
  it("returns false and touches nothing else when the status moved meanwhile", async () => {
    const { db, calls } = makeDb([])
    const push = vi.fn(async () => {})
    const applied = await applyHubnetStatusChange(db, row(), "completed", res("completed"), { push })
    expect(applied).toBe(false)
    expect(calls.map((c) => c.table)).toEqual(["mtn_fulfillment_tracking"])
    expect(calls[0].filters).toEqual([["id", "t1"], ["status", "processing"]])
    expect(push).not.toHaveBeenCalled()
  })

  it("failed maps the order table to pending", async () => {
    const { db, calls } = makeDb([{ id: "t1" }])
    await applyHubnetStatusChange(db, row(), "failed", res("failed", "failed"), { push: vi.fn(async () => {}) })
    expect(calls.find((c) => c.table === "tracking" || c.table === "mtn_fulfillment_tracking")!.payload.status).toBe("failed")
    expect(calls.find((c) => c.table === "orders")!.payload.status).toBe("pending")
  })

  it("completed notifies without any phone number", async () => {
    const { db, calls } = makeDb([{ id: "t1" }])
    const applied = await applyHubnetStatusChange(db, row({ recipient_phone: "0200000000" } as any), "completed", res("completed"), { push: vi.fn(async () => {}) })
    expect(applied).toBe(true)
    const notif = calls.find((c) => c.table === "notifications")!
    expect(notif.payload.type).toBe("order_completed")
    expect(JSON.stringify(notif.payload)).not.toMatch(/0200000000|\b0\d{9}\b/)
  })
})
