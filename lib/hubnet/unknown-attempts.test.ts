import { describe, it, expect, vi } from "vitest"
import { checkHubnetUnknownAttempts } from "./unknown-attempts"
import { hubnetRef } from "./core"
import type { StatusLookup } from "./core"

const U1 = "11111111-2222-4333-8444-555555555555"
const NOW = Date.parse("2026-11-21T12:00:00Z")

type Row = { id: string; shop_order_id: string | null; order_id: string | null; api_order_id: string | null; created_at: string }

function makeDb(rows: Row[]) {
  const writes: string[] = []
  const filters: Array<[string, any]> = []
  const b: any = {
    select: () => b,
    eq: (c: string, v: any) => (filters.push([c, v]), b),
    like: (c: string, v: any) => (filters.push([c + " like", v]), b),
    gte: (c: string, v: any) => (filters.push([c + " gte", v]), b),
    order: () => b,
    limit: () => b,
    update: () => (writes.push("update"), b),
    insert: () => (writes.push("insert"), b),
    delete: () => (writes.push("delete"), b),
    then: (res: any, rej: any) => Promise.resolve({ data: rows, error: null }).then(res, rej),
  }
  return { db: { from: () => b } as any, writes, filters }
}

const recent = new Date(NOW - 3_600_000).toISOString()
const found: StatusLookup = { kind: "found", status: "processing", refunded: false, raw: {} }
const missing: StatusLookup = { kind: "missing" }

describe("checkHubnetUnknownAttempts", () => {
  it("finds ref2 => exactly one alert, stops checking, tracking row untouched", async () => {
    const { db, writes } = makeDb([{ id: "t1", shop_order_id: U1, order_id: null, api_order_id: null, created_at: recent }])
    const getStatus = vi.fn(async (ref: string) => (ref === hubnetRef("data", U1, 2) ? found : missing))
    const alert = vi.fn(async () => {})
    const out = await checkHubnetUnknownAttempts(db, { getStatus } as any, alert, NOW)
    expect(out).toEqual({ checked: 1, found: 1 })
    expect(alert).toHaveBeenCalledTimes(1)
    const [type, , message] = alert.mock.calls[0] as any
    expect(type).toBe("hubnet_unknown_found:t1")
    expect(message).toContain(hubnetRef("data", U1, 2))
    expect(message).toContain("processing")
    expect(getStatus).toHaveBeenCalledTimes(2)
    expect(writes).toEqual([])
  })

  it("all refs missing or unknown => no alert", async () => {
    const { db } = makeDb([{ id: "t1", shop_order_id: null, order_id: U1, api_order_id: null, created_at: recent }])
    let n = 0
    const getStatus = vi.fn(async () => (n++ % 2 ? ({ kind: "unknown" } as StatusLookup) : missing))
    const alert = vi.fn(async () => {})
    const out = await checkHubnetUnknownAttempts(db, { getStatus } as any, alert, NOW)
    expect(out).toEqual({ checked: 1, found: 0 })
    expect(getStatus).toHaveBeenCalledTimes(5)
    expect(alert).not.toHaveBeenCalled()
  })

  it("row older than 48h is ignored (query bound) and defensively skipped", async () => {
    const old = new Date(NOW - 49 * 3_600_000).toISOString()
    const { db, filters } = makeDb([{ id: "t1", shop_order_id: U1, order_id: null, api_order_id: null, created_at: old }])
    const getStatus = vi.fn(async () => found)
    const alert = vi.fn(async () => {})
    const out = await checkHubnetUnknownAttempts(db, { getStatus } as any, alert, NOW)
    expect(out.found).toBe(0)
    expect(getStatus).not.toHaveBeenCalled()
    expect(filters).toContainEqual(["created_at gte", new Date(NOW - 48 * 3_600_000).toISOString()])
    expect(filters).toContainEqual(["provider", "hubnet"])
    expect(filters).toContainEqual(["status", "abandoned"])
    expect(filters).toContainEqual(["mtn_order_id like", "UNKNOWN_%"])
  })

  it("uses shop_order_id || order_id || api_order_id and skips non-uuid ids", async () => {
    const { db } = makeDb([
      { id: "t1", shop_order_id: "not-a-uuid", order_id: U1, api_order_id: null, created_at: recent },
      { id: "t2", shop_order_id: null, order_id: null, api_order_id: null, created_at: recent },
    ])
    const getStatus = vi.fn(async () => found)
    const alert = vi.fn(async () => {})
    const out = await checkHubnetUnknownAttempts(db, { getStatus } as any, alert, NOW)
    expect(out).toEqual({ checked: 0, found: 0 })
    expect(getStatus).not.toHaveBeenCalled()
  })
})
