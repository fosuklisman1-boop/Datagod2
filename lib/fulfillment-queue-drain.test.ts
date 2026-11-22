import { describe, it, expect, vi, beforeEach } from "vitest"

const processManualFulfillment = vi.fn()
vi.mock("@/lib/fulfillment-service", () => ({ processManualFulfillment: (...a: unknown[]) => processManualFulfillment(...a) }))
const fulfillUssdOrder = vi.fn()
vi.mock("@/lib/ussd/fulfill", () => ({ fulfillUssdOrder: (...a: unknown[]) => fulfillUssdOrder(...a) }))

import { drainFulfillmentQueue } from "./fulfillment-queue-drain"

// Minimal supabase double: reset-stale update, the claim RPC, the USSD order read and the row status updates.
function fakeSupabase(claimed: any[]) {
  const chain: any = {
    eq: () => chain,
    lt: () => chain,
    select: () => Promise.resolve({ data: [], error: null }),
    then: (ok: any, bad: any) => Promise.resolve({ error: null }).then(ok, bad),
  }
  return {
    rpc: vi.fn().mockResolvedValue({ data: claimed, error: null }),
    from(table: string) {
      return {
        update: () => chain,
        select: () => ({
          eq: (_c: string, id: string) => ({
            single: () =>
              Promise.resolve({
                data: { id, network: "MTN", recipient_phone: "0240000000", package_size: "1GB", _table: table },
                error: null,
              }),
          }),
        }),
      }
    },
  } as any
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
