import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const processManualFulfillment = vi.fn()
vi.mock("@/lib/fulfillment-service", () => ({ processManualFulfillment: (...a: unknown[]) => processManualFulfillment(...a) }))
const fulfillUssdOrder = vi.fn()
vi.mock("@/lib/ussd/fulfill", () => ({ fulfillUssdOrder: (...a: unknown[]) => fulfillUssdOrder(...a) }))
// The cron route is imported only to read its maxDuration; it builds a client at module load.
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => ({ authorized: true }) }))

import { drainFulfillmentQueue, STALE_MS, AUTO_PER_TICK, TIME_BUDGET_MS } from "./fulfillment-queue-drain"
import { DEFAULT_AUTO_FULFIL_SETTINGS } from "@/lib/auto-fulfil/settings"
import { NON_SEND_SWITCHED_OFF, NON_SEND_NOT_PENDING_PREFIX, NON_SEND_UNREADABLE } from "@/lib/auto-fulfil/policy"
import { maxDuration } from "@/app/api/cron/drain-fulfillment-queue/route"

type Call = { table: string; values: any; filters: { op: string; col: string; val: unknown }[] }

/**
 * Minimal supabase double: the reset-stale update, the claim RPC, the order reads and the queue row updates.
 * `orders` maps an order id to its row (any table); unknown ids read as a pending MTN order.
 */
type FakeOpts = {
  /** admin_settings auto_fulfil_pending value; undefined = no row (the off defaults). */
  settings?: unknown
  /** auto_fulfil_attempts update result. */
  attemptResult?: { data: any; error: any } | "throw"
}

function fakeSupabase(
  claimed: any[],
  orders: Record<string, any> = {},
  failRead: (id: string) => boolean = () => false,
  opts: FakeOpts = {},
) {
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
          const result = () => {
            if (table !== "auto_fulfil_attempts") return Promise.resolve({ data: [], error: null })
            const r = opts.attemptResult ?? { data: [{ id: "att" }], error: null }
            return r === "throw" ? Promise.reject(new Error("network down")) : Promise.resolve(r)
          }
          const chain: any = {
            eq: (col: string, val: unknown) => (call.filters.push({ op: "eq", col, val }), chain),
            lt: (col: string, val: unknown) => (call.filters.push({ op: "lt", col, val }), chain),
            in: (col: string, val: unknown) => (call.filters.push({ op: "in", col, val }), chain),
            is: (col: string, val: unknown) => (call.filters.push({ op: "is", col, val }), chain),
            select: () => result(),
            then: (ok: any, bad: any) => result().then(ok, bad),
          }
          return chain
        },
        select: (cols: string) => ({
          eq: (_c: string, id: string) => {
            if (table === "admin_settings") {
              const res = () => Promise.resolve({ data: opts.settings === undefined ? null : { value: opts.settings }, error: null })
              return { single: res, maybeSingle: res }
            }
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
                      payment_status: "completed",
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

const ON = { ...DEFAULT_AUTO_FULFIL_SETTINGS, enabled: true }
const queueUpdate = (sb: any, queueId: string) =>
  sb.updates.find((u: Call) => u.table === "fulfillment_queue" && u.filters.some((f) => f.col === "id" && f.val === queueId))
const attemptUpdates = (sb: any) => sb.updates.filter((u: Call) => u.table === "auto_fulfil_attempts")
const attemptFor = (sb: any, queueId: string) =>
  attemptUpdates(sb).find((u: Call) => u.filters.some((f) => f.col === "queue_id" && f.val === queueId))

describe("drainFulfillmentQueue — S2 payment re-check for auto rows", () => {
  it("auto shop row whose payment is not completed: no supplier call, 'order no longer pending (payment not completed)', attempt skipped", async () => {
    const sb = fakeSupabase([{ id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" }], { s1: { payment_status: "pending" } }, () => false, { settings: ON })
    const r = await drainFulfillmentQueue(sb)
    expect(processManualFulfillment).not.toHaveBeenCalled()
    expect(r).toMatchObject({ completed: 0, failed: 1 })
    expect(queueUpdate(sb, "q1").values).toEqual({ status: "failed", error_message: `${NON_SEND_NOT_PENDING_PREFIX} (payment not completed)` })
    expect(attemptFor(sb, "q1").values).toMatchObject({ outcome: "skipped" })
    expect(sb.reads[0].cols).toContain("payment_status")
  })

  it("auto ussd row with a missing payment status is skipped too; a completed one is sent", async () => {
    const sb = fakeSupabase(
      [
        { id: "q1", order_id: "u1", order_type: "ussd", provider: null, source: "auto" },
        { id: "q2", order_id: "u2", order_type: "ussd_shop", provider: null, source: "auto" },
      ],
      { u1: { payment_status: null } },
      () => false,
      { settings: ON },
    )
    await drainFulfillmentQueue(sb)
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(fulfillUssdOrder.mock.calls[0][0]).toBe("u2")
    expect(queueUpdate(sb, "q1").values.error_message).toBe(`${NON_SEND_NOT_PENDING_PREFIX} (payment not completed)`)
  })

  it("auto bulk row (no payment column) is unaffected", async () => {
    const sb = fakeSupabase([{ id: "q1", order_id: "b1", order_type: "bulk", provider: null, source: "auto" }], { b1: { payment_status: "pending" } }, () => false, { settings: ON })
    const r = await drainFulfillmentQueue(sb)
    expect(r).toMatchObject({ completed: 1, failed: 0 })
    expect(sb.reads[0].cols).not.toContain("payment_status")
  })

  it("admin rows are exactly as before: no payment check, payment column not read", async () => {
    const sb = fakeSupabase([{ id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "admin" }], { s1: { payment_status: "pending" } })
    const r = await drainFulfillmentQueue(sb)
    expect(r).toMatchObject({ completed: 1, failed: 0 })
    expect(sb.reads).toEqual([{ table: "shop_orders", cols: "order_status", id: "s1" }])
  })
})

describe("drainFulfillmentQueue — split claim and auto rows", () => {
  it("claims via claim_fulfillment_queue_split(20, 5)", async () => {
    const sb = fakeSupabase([])
    await drainFulfillmentQueue(sb)
    expect(sb.rpc).toHaveBeenCalledTimes(1)
    expect(sb.rpc).toHaveBeenCalledWith("claim_fulfillment_queue_split", { p_limit: 20, p_auto_limit: 5 })
    expect(AUTO_PER_TICK).toBe(5)
    expect(TIME_BUDGET_MS).toBe(240_000)
  })

  it("auto row with switch off: no supplier call, row failed 'auto-fulfil switched off', attempt outcome 'skipped'", async () => {
    const sb = fakeSupabase(
      [
        { id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" },
        { id: "q2", order_id: "u1", order_type: "ussd", provider: null, source: "auto" },
      ],
      {},
      () => false,
      { settings: { ...ON, enabled: false } },
    )
    const r = await drainFulfillmentQueue(sb)
    expect(processManualFulfillment).not.toHaveBeenCalled()
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(r).toMatchObject({ completed: 0, failed: 2 })
    expect(queueUpdate(sb, "q1").values).toEqual({ status: "failed", error_message: NON_SEND_SWITCHED_OFF })
    expect(queueUpdate(sb, "q2").values).toEqual({ status: "failed", error_message: "auto-fulfil switched off" })
    expect(attemptFor(sb, "q1").values).toMatchObject({ outcome: "skipped" })
    expect(attemptFor(sb, "q2").values).toMatchObject({ outcome: "skipped" })
    expect(typeof attemptFor(sb, "q1").values.finished_at).toBe("string")
    // switch is checked before the order is even read
    expect(sb.reads).toEqual([])
  })

  it("auto row with invalid settings fails closed: no supplier call, skipped", async () => {
    const sb = fakeSupabase([{ id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" }], {}, () => false, {
      settings: { enabled: true, junk: 1 },
    })
    await drainFulfillmentQueue(sb)
    expect(processManualFulfillment).not.toHaveBeenCalled()
    expect(queueUpdate(sb, "q1").values.error_message).toBe(NON_SEND_SWITCHED_OFF)
    expect(attemptFor(sb, "q1").values.outcome).toBe("skipped")
  })

  it("auto row with no settings row (defaults are off): no supplier call", async () => {
    const sb = fakeSupabase([{ id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" }])
    await drainFulfillmentQueue(sb)
    expect(processManualFulfillment).not.toHaveBeenCalled()
    expect(queueUpdate(sb, "q1").values.error_message).toBe(NON_SEND_SWITCHED_OFF)
  })

  it("an admin row is still sent while the auto switch is off", async () => {
    const sb = fakeSupabase(
      [
        { id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" },
        { id: "q2", order_id: "s2", order_type: "shop", provider: "hubnet", source: "admin" },
      ],
      {},
      () => false,
      { settings: { ...ON, enabled: false } },
    )
    const r = await drainFulfillmentQueue(sb)
    expect(processManualFulfillment.mock.calls).toEqual([["s2", "shop", "hubnet", true]])
    expect(r).toMatchObject({ completed: 1, failed: 1 })
    expect(attemptUpdates(sb)).toHaveLength(1)
  })

  it("auto row failure 'Rate limit exceeded' => attempt outcome rate_limited, fulfil called with suppressFailureAlerts", async () => {
    processManualFulfillment.mockResolvedValue({ success: false, message: "Rate limit exceeded" })
    fulfillUssdOrder.mockResolvedValue({ success: false, message: "Rate limit exceeded" })
    const sb = fakeSupabase(
      [
        { id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" },
        { id: "q2", order_id: "u1", order_type: "ussd", provider: null, source: "auto" },
      ],
      {},
      () => false,
      { settings: ON },
    )
    const r = await drainFulfillmentQueue(sb)
    expect(processManualFulfillment.mock.calls).toEqual([["s1", "shop", undefined, true, { suppressFailureAlerts: true }]])
    expect(fulfillUssdOrder.mock.calls).toEqual([
      ["u1", "MTN", "0240000000", "1GB", true, "ussd_orders", undefined, { suppressFailureAlerts: true }],
    ])
    expect(r).toMatchObject({ completed: 0, failed: 2 })
    expect(queueUpdate(sb, "q1").values).toEqual({ status: "failed", error_message: "Rate limit exceeded" })
    expect(attemptFor(sb, "q1").values).toMatchObject({ outcome: "rate_limited" })
    expect(attemptFor(sb, "q2").values).toMatchObject({ outcome: "rate_limited" })
  })

  it("auto row success => queue completed, attempt outcome sent (only a still-empty outcome is written)", async () => {
    const sb = fakeSupabase([{ id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" }], {}, () => false, { settings: ON })
    const r = await drainFulfillmentQueue(sb)
    expect(r).toMatchObject({ completed: 1, failed: 0 })
    expect(queueUpdate(sb, "q1").values.status).toBe("completed")
    const a = attemptFor(sb, "q1")
    expect(a.values).toMatchObject({ outcome: "sent" })
    expect(a.filters).toContainEqual({ op: "is", col: "outcome", val: null })
  })

  it("auto row whose message matches no rule => unclassified", async () => {
    processManualFulfillment.mockResolvedValue({ success: false, message: "something odd" })
    const sb = fakeSupabase([{ id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" }], {}, () => false, { settings: ON })
    await drainFulfillmentQueue(sb)
    expect(attemptFor(sb, "q1").values.outcome).toBe("unclassified")
  })

  it("auto ussd row with result.held => attempt outcome held", async () => {
    fulfillUssdOrder.mockResolvedValue({ success: false, message: "Held: number pending MTN registration", held: true })
    const sb = fakeSupabase([{ id: "q1", order_id: "u1", order_type: "ussd", provider: null, source: "auto" }], {}, () => false, { settings: ON })
    await drainFulfillmentQueue(sb)
    expect(queueUpdate(sb, "q1").values.status).toBe("failed")
    expect(attemptFor(sb, "q1").values.outcome).toBe("held")
  })

  it("auto row failure that leaves the order no longer pending (outcome unknown) => held", async () => {
    const orders: Record<string, any> = {}
    processManualFulfillment.mockImplementation(async (id: string) => {
      orders[id] = { order_status: "processing" }
      return { success: false, message: "Rate limit exceeded" }
    })
    const sb = fakeSupabase([{ id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" }], orders, () => false, {
      settings: ON,
    })
    await drainFulfillmentQueue(sb)
    expect(attemptFor(sb, "q1").values.outcome).toBe("held")
  })

  it("auto row failure whose order status cannot be re-read => unclassified (not a known refusal)", async () => {
    let calls = 0
    processManualFulfillment.mockImplementation(async () => {
      calls++
      return { success: false, message: "Rate limit exceeded" }
    })
    const sb = fakeSupabase([{ id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" }], {}, () => calls > 0, {
      settings: ON,
    })
    await drainFulfillmentQueue(sb)
    expect(processManualFulfillment).toHaveBeenCalledTimes(1)
    expect(attemptFor(sb, "q1").values.outcome).toBe("unclassified")
  })

  it("auto row whose call throws is still recorded (classified) and fails the queue row", async () => {
    processManualFulfillment.mockRejectedValue(new Error("Insufficient balance"))
    const sb = fakeSupabase([{ id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" }], {}, () => false, { settings: ON })
    const r = await drainFulfillmentQueue(sb)
    expect(r).toMatchObject({ failed: 1 })
    expect(queueUpdate(sb, "q1").values).toEqual({ status: "failed", error_message: "Insufficient balance" })
    expect(attemptFor(sb, "q1").values.outcome).not.toBe("sent")
  })

  it("auto row whose order is no longer pending: no supplier call, attempt outcome skipped", async () => {
    const sb = fakeSupabase([{ id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" }], { s1: { order_status: "completed" } }, () => false, {
      settings: ON,
    })
    await drainFulfillmentQueue(sb)
    expect(processManualFulfillment).not.toHaveBeenCalled()
    expect(queueUpdate(sb, "q1").values.error_message).toBe(`${NON_SEND_NOT_PENDING_PREFIX} (completed)`)
    expect(attemptFor(sb, "q1").values.outcome).toBe("skipped")
  })

  it("auto row with unreadable order: no supplier call, attempt outcome skipped", async () => {
    const sb = fakeSupabase([{ id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" }], {}, (id) => id === "s1", {
      settings: ON,
    })
    await drainFulfillmentQueue(sb)
    expect(processManualFulfillment).not.toHaveBeenCalled()
    expect(queueUpdate(sb, "q1").values.error_message).toBe(NON_SEND_UNREADABLE)
    expect(attemptFor(sb, "q1").values.outcome).toBe("skipped")
  })

  it.each([
    ["an error", { data: null, error: { message: "boom" } }],
    ["zero matched rows (attempt row not inserted yet)", { data: [], error: null }],
    ["a thrown error", "throw" as const],
  ])("attempt write with %s never changes the queue outcome or throws", async (_label, attemptResult) => {
    const sb = fakeSupabase(
      [
        { id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" },
        { id: "q2", order_id: "s2", order_type: "shop", provider: null, source: "auto" },
      ],
      {},
      () => false,
      { settings: ON, attemptResult },
    )
    const r = await drainFulfillmentQueue(sb)
    expect(r).toMatchObject({ completed: 2, failed: 0 })
    expect(queueUpdate(sb, "q1").values.status).toBe("completed")
    expect(queueUpdate(sb, "q2").values.status).toBe("completed")
    expect(processManualFulfillment).toHaveBeenCalledTimes(2)
  })

  it("the switch is re-read for every auto row and never for admin rows", async () => {
    const sb = fakeSupabase(
      [
        { id: "q0", order_id: "m1", order_type: "shop", provider: null, source: "admin" },
        { id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" },
        { id: "q2", order_id: "s2", order_type: "shop", provider: null, source: "auto" },
      ],
      {},
      () => false,
      { settings: ON },
    )
    const from = vi.spyOn(sb, "from")
    await drainFulfillmentQueue(sb)
    expect(from.mock.calls.filter((c) => c[0] === "admin_settings")).toHaveLength(2)
  })

  it("switching off mid-tick stops the next auto row before any supplier call", async () => {
    const opts: FakeOpts = { settings: ON }
    processManualFulfillment.mockImplementation(async () => {
      opts.settings = { ...ON, enabled: false }
      return { success: true, message: "ok" }
    })
    const sb = fakeSupabase(
      [
        { id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "auto" },
        { id: "q2", order_id: "s2", order_type: "shop", provider: null, source: "auto" },
      ],
      {},
      () => false,
      opts,
    )
    const r = await drainFulfillmentQueue(sb)
    expect(processManualFulfillment).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ completed: 1, failed: 1 })
    expect(queueUpdate(sb, "q2").values.error_message).toBe(NON_SEND_SWITCHED_OFF)
    expect(attemptFor(sb, "q2").values.outcome).toBe("skipped")
  })
})

describe("drainFulfillmentQueue — before 0193 is applied", () => {
  const byName = (split: { data: any; error: any }, plain: { data: any; error: any }) =>
    vi.fn(async (name: string) => (name === "claim_fulfillment_queue_split" ? split : plain))

  it.each([
    ["Postgres 42883", { code: "42883", message: "function claim_fulfillment_queue_split(integer, integer) does not exist" }],
    ["PostgREST PGRST202", { code: "PGRST202", message: "Could not find the function public.claim_fulfillment_queue_split" }],
  ])("a missing split function (%s) falls back to claim_fulfillment_queue and sends admin rows", async (_l, error) => {
    const sb = fakeSupabase([])
    sb.rpc = byName({ data: null, error }, { data: [{ id: "q1", order_id: "b1", order_type: "bulk", provider: null }], error: null })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const r = await drainFulfillmentQueue(sb)
      expect(sb.rpc).toHaveBeenCalledWith("claim_fulfillment_queue", { p_limit: 20 })
      expect(processManualFulfillment.mock.calls).toEqual([["b1", "bulk", undefined, true]])
      expect(r).toMatchObject({ claimed: 1, completed: 1 })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it("any other split claim error still throws (no fallback)", async () => {
    const sb = fakeSupabase([])
    sb.rpc = byName({ data: null, error: { code: "57014", message: "statement timeout" } }, { data: [], error: null })
    await expect(drainFulfillmentQueue(sb)).rejects.toThrow(/claim_fulfillment_queue_split failed/)
    expect(sb.rpc).toHaveBeenCalledTimes(1)
  })

  it("a fallback claim error throws", async () => {
    const sb = fakeSupabase([])
    sb.rpc = byName({ data: null, error: { code: "PGRST202", message: "missing" } }, { data: null, error: { message: "boom" } })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(drainFulfillmentQueue(sb)).rejects.toThrow(/claim_fulfillment_queue failed/)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("drainFulfillmentQueue — admin rows unchanged", () => {
  it("admin row is called without suppressFailureAlerts", async () => {
    processManualFulfillment.mockResolvedValue({ success: false, message: "Rate limit exceeded" })
    fulfillUssdOrder.mockResolvedValue({ success: false, message: "Rate limit exceeded" })
    const sb = fakeSupabase(
      [
        { id: "q1", order_id: "s1", order_type: "shop", provider: "hubnet", source: "admin" },
        { id: "q2", order_id: "u1", order_type: "ussd", provider: null, source: "admin" },
        { id: "q3", order_id: "b1", order_type: "bulk", provider: null }, // pre-0193 shape: no source column
      ],
      {},
      () => false,
      { settings: ON },
    )
    await drainFulfillmentQueue(sb)
    expect(processManualFulfillment.mock.calls).toEqual([
      ["s1", "shop", "hubnet", true],
      ["b1", "bulk", undefined, true],
    ])
    expect(fulfillUssdOrder.mock.calls).toEqual([["u1", "MTN", "0240000000", "1GB", true, "ussd_orders", undefined]])
    expect(attemptUpdates(sb)).toEqual([])
    expect(queueUpdate(sb, "q1").values).toEqual({ status: "failed", error_message: "Rate limit exceeded" })
  })
})

describe("drainFulfillmentQueue — time budget", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-22T12:00:00.000Z"))
  })
  afterEach(() => vi.useRealTimers())

  it("rows left after the time budget go back to pending unsent", async () => {
    processManualFulfillment.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + TIME_BUDGET_MS + 1_000)
      return { success: true, message: "ok" }
    })
    const sb = fakeSupabase(
      [
        { id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "admin" },
        { id: "q2", order_id: "s2", order_type: "shop", provider: null, source: "admin" },
        { id: "q3", order_id: "u1", order_type: "ussd", provider: null, source: "auto" },
      ],
      {},
      () => false,
      { settings: ON },
    )
    const r = await drainFulfillmentQueue(sb)
    expect(processManualFulfillment).toHaveBeenCalledTimes(1)
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    const back = sb.updates.find((u: Call) => u.table === "fulfillment_queue" && u.filters.some((f) => f.op === "in" && f.col === "id"))!
    expect(back.values).toEqual({ status: "pending" })
    expect(back.filters).toContainEqual({ op: "in", col: "id", val: ["q2", "q3"] })
    expect(back.filters).toContainEqual({ op: "eq", col: "status", val: "processing" })
    expect(r).toMatchObject({ claimed: 3, completed: 1, failed: 0, requeued: 2 })
    // the requeued auto row's attempt stays open (no outcome written)
    expect(attemptUpdates(sb)).toEqual([])
  })

  it("a fast tick sends every row", async () => {
    const sb = fakeSupabase([
      { id: "q1", order_id: "s1", order_type: "shop", provider: null, source: "admin" },
      { id: "q2", order_id: "s2", order_type: "shop", provider: null, source: "admin" },
    ])
    const r = await drainFulfillmentQueue(sb)
    expect(r).toMatchObject({ completed: 2, requeued: 0 })
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
