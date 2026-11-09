import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => {}) }))

import { applyKuntaniiStatusChange, type KuntaniiSyncRow } from "./kuntanii-sync"

type Call = { table: string; op: string; payload?: any; filters: Array<[string, any]> }

/** Fake supabase: records every call; the tracking update returns `trackingRows`. */
function makeDb(trackingRows: any[]) {
  const calls: Call[] = []
  function from(table: string) {
    const call: Call = { table, op: "select", filters: [] }
    calls.push(call)
    const result = () => {
      if (table === "mtn_fulfillment_tracking" && call.op === "update") return { data: trackingRows, error: null }
      if (table === "orders" && call.op === "update") return { data: { user_id: "user-1" }, error: null }
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

const order = (over: Partial<KuntaniiSyncRow> = {}): KuntaniiSyncRow => ({
  id: "t1",
  mtn_order_id: "ord-1",
  status: "processing",
  shop_order_id: null,
  order_id: "o1",
  api_order_id: null,
  order_type: "bulk",
  size_gb: 1,
  ...over,
})

const result = { success: true, status: "completed", message: "Kuntanii status: completed", order: { status: "processed" } }

describe("applyKuntaniiStatusChange", () => {
  it("guards the tracking update on the old status", async () => {
    const { db, calls } = makeDb([{ id: "t1" }])
    await applyKuntaniiStatusChange(db, order(), "completed", result, { push: vi.fn(async () => {}) })
    const upd = calls.find((c) => c.table === "mtn_fulfillment_tracking")!
    expect(upd.op).toBe("update")
    expect(upd.filters).toEqual([["id", "t1"], ["status", "processing"]])
    expect(upd.payload.status).toBe("completed")
    expect(upd.payload.external_status).toBe("processed")
  })

  it("lost race (update returns no row): no mirror, no notification", async () => {
    const { db, calls } = makeDb([])
    const push = vi.fn(async () => {})
    const applied = await applyKuntaniiStatusChange(db, order(), "completed", result, { push })
    expect(applied).toBe(false)
    expect(calls.map((c) => c.table)).toEqual(["mtn_fulfillment_tracking"])
    expect(push).not.toHaveBeenCalled()
  })

  it("won race: mirrors to the order table and notifies", async () => {
    const { db, calls } = makeDb([{ id: "t1" }])
    const push = vi.fn(async () => {})
    const applied = await applyKuntaniiStatusChange(db, order(), "completed", result, { push })
    expect(applied).toBe(true)
    const mirror = calls.find((c) => c.table === "orders")!
    expect(mirror.payload.status).toBe("completed")
    expect(mirror.filters).toEqual([["id", "o1"]])
    const notif = calls.find((c) => c.table === "notifications")!
    expect(notif.op).toBe("insert")
    expect(notif.payload.user_id).toBe("user-1")
    expect(notif.payload.type).toBe("order_completed")
    expect(push).toHaveBeenCalledTimes(1)
  })

  it("failed maps the order table to pending", async () => {
    const { db, calls } = makeDb([{ id: "t1" }])
    await applyKuntaniiStatusChange(db, order(), "failed", { ...result, status: "failed" }, { push: vi.fn(async () => {}) })
    expect(calls.find((c) => c.table === "orders")!.payload.status).toBe("pending")
  })

  it("tracking update error throws and mirrors nothing", async () => {
    const calls: string[] = []
    const db: any = {
      from(table: string) {
        calls.push(table)
        const b: any = {
          update: () => b,
          eq: () => b,
          select: () => Promise.resolve({ data: null, error: { message: "db down" } }),
        }
        return b
      },
    }
    await expect(
      applyKuntaniiStatusChange(db, order(), "completed", result, { push: vi.fn(async () => {}) }),
    ).rejects.toThrow(/db down/)
    expect(calls).toEqual(["mtn_fulfillment_tracking"])
  })
})
