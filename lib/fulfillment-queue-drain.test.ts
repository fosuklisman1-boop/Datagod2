import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const processManualFulfillment = vi.fn()
vi.mock("@/lib/fulfillment-service", () => ({ processManualFulfillment: (...a: unknown[]) => processManualFulfillment(...a) }))
const fulfillUssdOrder = vi.fn()
vi.mock("@/lib/ussd/fulfill", () => ({ fulfillUssdOrder: (...a: unknown[]) => fulfillUssdOrder(...a) }))
// The cron route is imported only to read its maxDuration; it builds a client at module load.
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => ({ authorized: true }) }))

import { drainFulfillmentQueue, STALE_MS } from "./fulfillment-queue-drain"
import { maxDuration } from "@/app/api/cron/drain-fulfillment-queue/route"

type Call = { table: string; values: any; filters: { op: string; col: string; val: unknown }[] }

/**
 * Minimal supabase double: the reset-stale update, the claim RPC, the order reads and the queue row updates.
 * `orders` maps an order id to its row (any table); unknown ids read as a pending MTN order.
 */
function fakeSupabase(claimed: any[], orders: Record<string, any> = {}, failRead: (id: string) => boolean = () => false) {
  const updates: Call[] = []
  const reads: { table: string; cols: string; id: string }[] = []
  const sb = {
    updates,
    reads,
    rpc: vi.fn().mockResolvedValue({ data: claimed, error: null }),
    from(table: string) {
      return {
        update: (values: any) => {
          const call: Call = { table, values, filters: [] }
          updates.push(call)
          const chain: any = {
            eq: (col: string, val: unknown) => (call.filters.push({ op: "eq", col, val }), chain),
            lt: (col: string, val: unknown) => (call.filters.push({ op: "lt", col, val }), chain),
            select: () => Promise.resolve({ data: [], error: null }),
            then: (ok: any, bad: any) => Promise.resolve({ error: null }).then(ok, bad),
          }
          return chain
        },
        select: (cols: string) => ({
          eq: (_c: string, id: string) => {
            reads.push({ table, cols, id })
            const res = () =>
              failRead(id)
                ? Promise.resolve({ data: null, error: { message: "boom" } })
                : Promise.resolve({
                    data: {
                      id,
                      network: "MTN",
                      recipient_phone: "0240000000",
                      package_size: "1GB",
                      status: "pending",
                      order_status: "pending",
                      ...orders[id],
                    },
                    error: null,
                  })
            return { single: res, maybeSingle: res }
          },
        }),
      }
    },
  }
  return sb as any
}

beforeEach(() => {
  vi.clearAllMocks()
  fulfillUssdOrder.mockResolvedValue({ success: true, message: "ok" })
  processManualFulfillment.mockResolvedValue({ success: true, message: "ok" })
})

describe("drainFulfillmentQueue — the chosen supplier reaches every path", () => {
  it("passes row.provider as the 7th argument to fulfillUssdOrder for ussd and ussd_shop", async () => {
    const sb = fakeSupabase([
      { id: "q1", order_id: "u1", order_type: "ussd", provider: "hubnet" },
      { id: "q2", order_id: "u2", order_type: "ussd_shop", provider: "hubnet" },
    ])
    const r = await drainFulfillmentQueue(sb)
    expect(r.completed).toBe(2)
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(2)
    expect(fulfillUssdOrder.mock.calls[0]).toEqual(["u1", "MTN", "0240000000", "1GB", true, "ussd_orders", "hubnet"])
    expect(fulfillUssdOrder.mock.calls[1]).toEqual(["u2", "MTN", "0240000000", "1GB", true, "ussd_shop_orders", "hubnet"])
  })

  it("a ussd row with no provider passes undefined (auto routing, unchanged)", async () => {
    await drainFulfillmentQueue(fakeSupabase([{ id: "q1", order_id: "u1", order_type: "ussd", provider: null }]))
    expect(fulfillUssdOrder.mock.calls[0][6]).toBeUndefined()
  })

  it("shop and bulk rows are unchanged: processManualFulfillment(id, type, provider, skipSms=true)", async () => {
    await drainFulfillmentQueue(
      fakeSupabase([
        { id: "q1", order_id: "s1", order_type: "shop", provider: "hubnet" },
        { id: "q2", order_id: "b1", order_type: "bulk", provider: null },
      ]),
    )
    expect(processManualFulfillment.mock.calls).toEqual([
      ["s1", "shop", "hubnet", true],
      ["b1", "bulk", undefined, true],
    ])
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
  })
})

describe("drainFulfillmentQueue — re-checks the order is still pending before any supplier call", () => {
  const failedUpdate = (sb: any, queueId: string) =>
    sb.updates.find((u: Call) => u.table === "fulfillment_queue" && u.filters.some((f) => f.col === "id" && f.val === queueId))

  it("a ussd order already processing is not dispatched and its queue row is failed", async () => {
    const sb = fakeSupabase([{ id: "q1", order_id: "u1", order_type: "ussd", provider: "hubnet" }], { u1: { order_status: "processing" } })
    const r = await drainFulfillmentQueue(sb)
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(r).toMatchObject({ completed: 0, failed: 1 })
    expect(failedUpdate(sb, "q1").values).toEqual({ status: "failed", error_message: "order no longer pending (processing)" })
    expect(sb.reads[0]).toMatchObject({ table: "ussd_orders", id: "u1" })
    expect(sb.reads[0].cols).toContain("order_status")
  })

  it("a shop order already processing is not dispatched and its queue row is failed", async () => {
    const sb = fakeSupabase([{ id: "q1", order_id: "s1", order_type: "shop", provider: "hubnet" }], { s1: { order_status: "processing" } })
    const r = await drainFulfillmentQueue(sb)
    expect(processManualFulfillment).not.toHaveBeenCalled()
    expect(r).toMatchObject({ completed: 0, failed: 1 })
    expect(failedUpdate(sb, "q1").values).toEqual({ status: "failed", error_message: "order no longer pending (processing)" })
    expect(sb.reads).toEqual([{ table: "shop_orders", cols: "order_status", id: "s1" }])
  })

  it("pending ussd_shop and shop orders are dispatched", async () => {
    const sb = fakeSupabase([
      { id: "q1", order_id: "u1", order_type: "ussd_shop", provider: "hubnet" },
      { id: "q2", order_id: "s1", order_type: "shop", provider: "hubnet" },
    ])
    const r = await drainFulfillmentQueue(sb)
    expect(r).toMatchObject({ completed: 2, failed: 0 })
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(processManualFulfillment.mock.calls).toEqual([["s1", "shop", "hubnet", true]])
  })

  it("reads each type's own status column from its own table", async () => {
    const sb = fakeSupabase([
      { id: "q1", order_id: "b1", order_type: "bulk", provider: null },
      { id: "q2", order_id: "a1", order_type: "api", provider: null },
      { id: "q3", order_id: "s1", order_type: "shop", provider: null },
    ])
    await drainFulfillmentQueue(sb)
    expect(sb.reads).toEqual([
      { table: "orders", cols: "status", id: "b1" },
      { table: "api_orders", cols: "status", id: "a1" },
      { table: "shop_orders", cols: "order_status", id: "s1" },
    ])
  })

  it("bulk / api orders that are completed or reversed are skipped too", async () => {
    const sb = fakeSupabase(
      [
        { id: "q1", order_id: "b1", order_type: "bulk", provider: null },
        { id: "q2", order_id: "a1", order_type: "api", provider: null },
      ],
      { b1: { status: "completed" }, a1: { status: "reversed" } },
    )
    await drainFulfillmentQueue(sb)
    expect(processManualFulfillment).not.toHaveBeenCalled()
    expect(failedUpdate(sb, "q1").values.error_message).toBe("order no longer pending (completed)")
    expect(failedUpdate(sb, "q2").values.error_message).toBe("order no longer pending (reversed)")
  })

  it("an unreadable order status fails the row without a supplier call; the next row still runs", async () => {
    const sb = fakeSupabase(
      [
        { id: "q1", order_id: "s1", order_type: "shop", provider: "hubnet" },
        { id: "q2", order_id: "u1", order_type: "ussd", provider: "hubnet" },
        { id: "q3", order_id: "b1", order_type: "bulk", provider: null },
      ],
      {},
      (id) => id === "s1" || id === "u1",
    )
    const r = await drainFulfillmentQueue(sb)
    expect(processManualFulfillment.mock.calls).toEqual([["b1", "bulk", undefined, true]])
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(failedUpdate(sb, "q1").values).toEqual({ status: "failed", error_message: "order status unreadable" })
    expect(failedUpdate(sb, "q2").values).toEqual({ status: "failed", error_message: "order status unreadable" })
    expect(r).toMatchObject({ completed: 1, failed: 2 })
  })
})

describe("drainFulfillmentQueue — stale reset never overlaps a live tick", () => {
  const NOW = new Date("2026-11-22T12:00:00.000Z")
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it("STALE_MS is strictly greater than the drain route's maxDuration", () => {
    expect(STALE_MS).toBeGreaterThan(maxDuration * 1000)
  })

  it("a row claimed 5 minutes ago is NOT reset; one claimed 7 minutes ago is", async () => {
    const sb = fakeSupabase([])
    await drainFulfillmentQueue(sb)
    const reset = sb.updates.find((u: Call) => u.table === "fulfillment_queue" && u.values.status === "pending")!
    expect(reset.filters).toContainEqual({ op: "eq", col: "status", val: "processing" })
    const lt = reset.filters.find((f: any) => f.op === "lt" && f.col === "last_attempted_at")!
    const threshold = new Date(String(lt.val)).getTime()
    const claimedAt = (minutesAgo: number) => NOW.getTime() - minutesAgo * 60_000
    // `.lt(last_attempted_at, threshold)` resets only rows older than the threshold.
    expect(claimedAt(5) < threshold).toBe(false)
    expect(claimedAt(7) < threshold).toBe(true)
  })
})
