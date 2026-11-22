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
