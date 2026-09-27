import { describe, it, expect } from "vitest"
import { getLatestCompletedOrder, getNetworkHealth, HEALTH_NETWORKS } from "./order-health-service"

interface FakeOrder {
  id: string
  user_id: string
  network: string
  status: string
  size?: string
  phone_number?: string
  created_at: string
  updated_at: string
}

// Generic chainable fake query builder for the `orders` table. Supports the
// specific combination of .select/.eq/.gte/.order/.limit/.maybeSingle used by
// lib/order-health-service.ts, and is itself thenable so a bare `await`
// (no .maybeSingle()) resolves to { data: <array>, error: null } the same
// way the real Supabase query builder does.
function makeOrdersQuery(rows: FakeOrder[]) {
  let filtered = rows.slice()
  const builder: any = {
    select: () => builder,
    eq: (col: string, val: any) => {
      filtered = filtered.filter((r: any) => r[col] === val)
      return builder
    },
    gte: (col: string, val: string) => {
      filtered = filtered.filter((r: any) => new Date(r[col]).getTime() >= new Date(val).getTime())
      return builder
    },
    order: (col: string, opts: { ascending: boolean }) => {
      filtered = filtered
        .slice()
        .sort((a: any, b: any) =>
          opts.ascending
            ? new Date(a[col]).getTime() - new Date(b[col]).getTime()
            : new Date(b[col]).getTime() - new Date(a[col]).getTime()
        )
      return builder
    },
    limit: (n: number) => {
      filtered = filtered.slice(0, n)
      return builder
    },
    maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
    then: (resolve: any, reject: any) => Promise.resolve({ data: filtered, error: null }).then(resolve, reject),
  }
  return builder
}

function createFakeSupabase(rows: FakeOrder[]) {
  return {
    from(table: string) {
      if (table === "orders") return makeOrdersQuery(rows)
      throw new Error(`Unexpected table: ${table}`)
    },
  } as any
}

function order(overrides: Partial<FakeOrder> & { id: string }): FakeOrder {
  return {
    user_id: "user-1",
    network: "MTN",
    status: "completed",
    size: "5",
    phone_number: "0541234567",
    created_at: "2026-09-27T10:00:00.000Z",
    updated_at: "2026-09-27T10:20:00.000Z",
    ...overrides,
  }
}

describe("getLatestCompletedOrder", () => {
  it("returns null when the user has no completed orders", async () => {
    const supabase = createFakeSupabase([order({ id: "o1", user_id: "other-user" })])
    const result = await getLatestCompletedOrder(supabase, "user-1")
    expect(result).toBeNull()
  })

  it("returns the user's most recent completed order with correct duration", async () => {
    const rows = [
      order({ id: "older", created_at: "2026-09-27T08:00:00.000Z", updated_at: "2026-09-27T08:20:00.000Z" }),
      order({ id: "latest", created_at: "2026-09-27T10:00:00.000Z", updated_at: "2026-09-27T10:20:00.000Z" }),
    ]
    const supabase = createFakeSupabase(rows)
    const result = await getLatestCompletedOrder(supabase, "user-1")
    expect(result).not.toBeNull()
    expect(result!.durationMinutes).toBe(20)
    expect(result!.network).toBe("MTN")
  })

  it("reports hasHeldOrder true when the user has a held_registration row", async () => {
    const rows = [
      order({ id: "completed-1" }),
      order({ id: "held-1", status: "held_registration" }),
    ]
    const supabase = createFakeSupabase(rows)
    const result = await getLatestCompletedOrder(supabase, "user-1")
    expect(result!.hasHeldOrder).toBe(true)
  })

  it("reports hasHeldOrder false when the user has no held_registration row", async () => {
    const supabase = createFakeSupabase([order({ id: "completed-1" })])
    const result = await getLatestCompletedOrder(supabase, "user-1")
    expect(result!.hasHeldOrder).toBe(false)
  })

  it("omits avgNetworkDurationMinutes when this order is the only same-network completed order in the window", async () => {
    const supabase = createFakeSupabase([order({ id: "only-one" })])
    const result = await getLatestCompletedOrder(supabase, "user-1")
    expect(result!.avgNetworkDurationMinutes).toBeNull()
  })

  it("computes avgNetworkDurationMinutes across other same-network completed orders in the window", async () => {
    const rows = [
      order({ id: "mine", user_id: "user-1", created_at: "2026-09-27T10:00:00.000Z", updated_at: "2026-09-27T10:20:00.000Z" }), // 20 min
      order({ id: "someone-elses-1", user_id: "user-2", created_at: "2026-09-27T09:00:00.000Z", updated_at: "2026-09-27T09:10:00.000Z" }), // 10 min
    ]
    const supabase = createFakeSupabase(rows)
    const result = await getLatestCompletedOrder(supabase, "user-1")
    // average of 20 and 10 = 15
    expect(result!.avgNetworkDurationMinutes).toBe(15)
  })
})

describe("getNetworkHealth", () => {
  it("reports no_data with null stats for a network with zero resolved orders in the window", async () => {
    const supabase = createFakeSupabase([])
    const result = await getNetworkHealth(supabase)
    expect(result).toHaveLength(HEALTH_NETWORKS.length)
    for (const stat of result) {
      expect(stat.status).toBe("no_data")
      expect(stat.uptimePercent).toBeNull()
      expect(stat.avgDeliveryMinutes).toBeNull()
      expect(stat.sampleSize).toBe(0)
    }
  })

  it("reports optimal with correct avg delivery when all orders for a network completed", async () => {
    const rows = [
      order({ id: "m1", network: "MTN", status: "completed", created_at: "2026-09-27T10:00:00.000Z", updated_at: "2026-09-27T10:10:00.000Z" }),
      order({ id: "m2", network: "MTN", status: "completed", created_at: "2026-09-27T10:00:00.000Z", updated_at: "2026-09-27T10:20:00.000Z" }),
    ]
    const supabase = createFakeSupabase(rows)
    const result = await getNetworkHealth(supabase)
    const mtn = result.find((r) => r.network === "MTN")!
    expect(mtn.status).toBe("optimal")
    expect(mtn.uptimePercent).toBe(100)
    expect(mtn.avgDeliveryMinutes).toBe(15) // avg of 10 and 20
    expect(mtn.sampleSize).toBe(2)
  })

  it("computes correct uptime percent from a mix of completed/failed, excluding pending from the denominator", async () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => order({ id: `c${i}`, network: "Telecel", status: "completed" })),
      ...Array.from({ length: 2 }, (_, i) => order({ id: `f${i}`, network: "Telecel", status: "failed" })),
      order({ id: "pending-1", network: "Telecel", status: "pending" }), // must NOT count in the denominator
    ]
    const supabase = createFakeSupabase(rows)
    const result = await getNetworkHealth(supabase)
    const telecel = result.find((r) => r.network === "Telecel")!
    expect(telecel.sampleSize).toBe(10) // 8 completed + 2 failed, NOT +1 pending
    expect(telecel.uptimePercent).toBe(80)
    expect(telecel.status).toBe("down") // below the 90% "degraded" threshold
  })

  it("buckets inconsistent network casing/spelling into the right canonical network", async () => {
    const rows = [
      order({ id: "a1", network: "at - ishare", status: "completed" }),
      order({ id: "a2", network: "AT-ISHARE", status: "completed" }),
      order({ id: "a3", network: "ishare", status: "completed" }),
    ]
    const supabase = createFakeSupabase(rows)
    const result = await getNetworkHealth(supabase)
    const ishare = result.find((r) => r.network === "AT - iShare")!
    expect(ishare.sampleSize).toBe(3)
    expect(ishare.status).toBe("optimal")
  })

  it("drops an unrecognized network value instead of force-fitting it into a bucket", async () => {
    const rows = [
      order({ id: "weird-1", network: "SomeOtherNetwork", status: "completed" }),
      order({ id: "at-1", network: "AT", status: "completed" }), // plain "AT" is NOT a tracked bucket
    ]
    const supabase = createFakeSupabase(rows)
    const result = await getNetworkHealth(supabase)
    for (const stat of result) {
      expect(stat.sampleSize).toBe(0) // neither row landed anywhere
    }
  })

  it("excludes failed/reversed orders from the avg-delivery calculation", async () => {
    const rows = [
      order({ id: "completed-1", network: "MTN", status: "completed", created_at: "2026-09-27T10:00:00.000Z", updated_at: "2026-09-27T10:10:00.000Z" }), // 10 min
      // A failed order with a huge created->updated gap. If this leaked into
      // the avg-delivery average, it would massively skew the result away
      // from 10 — this test would then fail, catching the regression.
      order({ id: "failed-1", network: "MTN", status: "failed", created_at: "2026-09-27T00:00:00.000Z", updated_at: "2026-09-27T23:00:00.000Z" }),
    ]
    const supabase = createFakeSupabase(rows)
    const result = await getNetworkHealth(supabase)
    const mtn = result.find((r) => r.network === "MTN")!
    expect(mtn.avgDeliveryMinutes).toBe(10)
    expect(mtn.sampleSize).toBe(2) // both count toward uptime...
    expect(mtn.uptimePercent).toBe(50) // ...but only the completed one feeds avgDeliveryMinutes
  })

  it("returns all four networks in the fixed HEALTH_NETWORKS order", async () => {
    const supabase = createFakeSupabase([])
    const result = await getNetworkHealth(supabase)
    expect(result.map((r) => r.network)).toEqual([...HEALTH_NETWORKS])
  })
})
