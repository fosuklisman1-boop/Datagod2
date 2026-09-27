import { describe, it, expect } from "vitest"
import { getLatestCompletedOrder, getNetworkHealth, HEALTH_NETWORKS } from "./order-health-service"

interface FakeOrder {
  id: string
  user_id?: string
  network: string
  status?: string // "orders"/"api_orders"
  order_status?: string // "shop_orders"/"ussd_orders"/"ussd_shop_orders"
  payment_status?: string
  size?: string
  phone_number?: string
  created_at: string
  updated_at?: string | null
}

interface FakeTrackingRow {
  order_id?: string
  shop_order_id?: string
  api_order_id?: string
  order_type: string
  status: string
  created_at: string
}

const ORDER_TABLES = ["orders", "api_orders", "shop_orders", "ussd_orders", "ussd_shop_orders"]

// Generic chainable fake query builder for any of the 5 order tables. Supports
// the specific combination of .select/.eq/.gte/.order/.limit/.maybeSingle used
// by lib/order-health-service.ts, and is itself thenable so a bare `await`
// (no .maybeSingle()) resolves to { data: <array>, error: null } the same way
// the real Supabase query builder does.
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

// Fake builder for mtn_fulfillment_tracking, supporting .select/.eq/.in used
// by getDispatchTimestamps().
function makeTrackingQuery(rows: FakeTrackingRow[]) {
  let filtered = rows.slice()
  const builder: any = {
    select: () => builder,
    eq: (col: string, val: any) => {
      filtered = filtered.filter((r: any) => r[col] === val)
      return builder
    },
    in: (col: string, vals: string[]) => {
      filtered = filtered.filter((r: any) => vals.includes(r[col]))
      return builder
    },
    then: (resolve: any, reject: any) => Promise.resolve({ data: filtered, error: null }).then(resolve, reject),
  }
  return builder
}

function createFakeSupabase(
  orderTables: Partial<Record<(typeof ORDER_TABLES)[number], FakeOrder[]>>,
  tracking: FakeTrackingRow[] = []
) {
  return {
    from(table: string) {
      if (ORDER_TABLES.includes(table)) return makeOrdersQuery(orderTables[table] ?? [])
      if (table === "mtn_fulfillment_tracking") return makeTrackingQuery(tracking)
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

function tracking(overrides: Partial<FakeTrackingRow> & { order_id?: string; shop_order_id?: string; api_order_id?: string }): FakeTrackingRow {
  return {
    order_type: "bulk",
    status: "completed",
    created_at: "2026-09-27T10:05:00.000Z",
    ...overrides,
  } as FakeTrackingRow
}

describe("getLatestCompletedOrder", () => {
  it("returns null when the user has no completed orders", async () => {
    const supabase = createFakeSupabase({ orders: [order({ id: "o1", user_id: "other-user" })] })
    const result = await getLatestCompletedOrder(supabase, "user-1")
    expect(result).toBeNull()
  })

  it("falls back to placed-time duration when no tracking row exists", async () => {
    const rows = [
      order({ id: "older", created_at: "2026-09-27T08:00:00.000Z", updated_at: "2026-09-27T08:20:00.000Z" }),
      order({ id: "latest", created_at: "2026-09-27T10:00:00.000Z", updated_at: "2026-09-27T10:20:00.000Z" }),
    ]
    const supabase = createFakeSupabase({ orders: rows }) // no tracking rows at all
    const result = await getLatestCompletedOrder(supabase, "user-1")
    expect(result).not.toBeNull()
    expect(result!.durationMinutes).toBe(20) // placed 10:00 -> completed 10:20, no dispatch row to override
    expect(result!.network).toBe("MTN")
  })

  it("measures duration from dispatch time (tracking row), not placement time, when a tracking row exists", async () => {
    const rows = [order({ id: "latest", created_at: "2026-09-27T10:00:00.000Z", updated_at: "2026-09-27T10:20:00.000Z" })]
    // Placed at 10:00, but only actually pushed to the supplier at 10:15 (internal
    // queueing delay) — duration should be dispatch(10:15)->completed(10:20) = 5m,
    // not placed(10:00)->completed(10:20) = 20m.
    const track = [tracking({ order_id: "latest", created_at: "2026-09-27T10:15:00.000Z" })]
    const supabase = createFakeSupabase({ orders: rows }, track)
    const result = await getLatestCompletedOrder(supabase, "user-1")
    expect(result!.durationMinutes).toBe(5)
  })

  it("ignores dead tracking rows (failed/abandoned) and picks the most recent live one", async () => {
    const rows = [order({ id: "latest", created_at: "2026-09-27T10:00:00.000Z", updated_at: "2026-09-27T10:30:00.000Z" })]
    const track = [
      tracking({ order_id: "latest", status: "abandoned", created_at: "2026-09-27T10:01:00.000Z" }), // dead — ignored
      tracking({ order_id: "latest", status: "failed", created_at: "2026-09-27T10:05:00.000Z" }), // dead — ignored (a retry attempt that failed)
      tracking({ order_id: "latest", status: "completed", created_at: "2026-09-27T10:10:00.000Z" }), // the live, successful attempt
    ]
    const supabase = createFakeSupabase({ orders: rows }, track)
    const result = await getLatestCompletedOrder(supabase, "user-1")
    // dispatch(10:10) -> completed(10:30) = 20m, not from the dead rows at 10:01/10:05
    expect(result!.durationMinutes).toBe(20)
  })

  it("reports hasHeldOrder true when the user has a held_registration row", async () => {
    const rows = [
      order({ id: "completed-1" }),
      order({ id: "held-1", status: "held_registration" }),
    ]
    const supabase = createFakeSupabase({ orders: rows })
    const result = await getLatestCompletedOrder(supabase, "user-1")
    expect(result!.hasHeldOrder).toBe(true)
  })

  it("reports hasHeldOrder false when the user has no held_registration row", async () => {
    const supabase = createFakeSupabase({ orders: [order({ id: "completed-1" })] })
    const result = await getLatestCompletedOrder(supabase, "user-1")
    expect(result!.hasHeldOrder).toBe(false)
  })

  it("omits avgNetworkDurationMinutes when this order is the only same-network completed order in the window", async () => {
    const supabase = createFakeSupabase({ orders: [order({ id: "only-one" })] })
    const result = await getLatestCompletedOrder(supabase, "user-1")
    expect(result!.avgNetworkDurationMinutes).toBeNull()
  })

  it("computes avgNetworkDurationMinutes using dispatch time across other same-network completed orders", async () => {
    const rows = [
      order({ id: "mine", user_id: "user-1", created_at: "2026-09-27T10:00:00.000Z", updated_at: "2026-09-27T10:20:00.000Z" }), // no tracking row -> placed->completed = 20 min
      order({ id: "someone-elses-1", user_id: "user-2", created_at: "2026-09-27T09:00:00.000Z", updated_at: "2026-09-27T09:10:00.000Z" }), // dispatch overrides to 5 min
    ]
    const track = [tracking({ order_id: "someone-elses-1", created_at: "2026-09-27T09:05:00.000Z" })]
    const supabase = createFakeSupabase({ orders: rows }, track)
    const result = await getLatestCompletedOrder(supabase, "user-1")
    // average of 20 (mine, no tracking) and 5 (someone-elses-1, dispatch-based) = 12.5 -> rounds to 13
    expect(result!.avgNetworkDurationMinutes).toBe(13)
  })
})

describe("getNetworkHealth", () => {
  it("reports no_data with null stats for a network with zero resolved orders in the window", async () => {
    const supabase = createFakeSupabase({})
    const result = await getNetworkHealth(supabase)
    expect(result).toHaveLength(HEALTH_NETWORKS.length)
    for (const stat of result) {
      expect(stat.status).toBe("no_data")
      expect(stat.uptimePercent).toBeNull()
      expect(stat.avgDeliveryMinutes).toBeNull()
      expect(stat.sampleSize).toBe(0)
    }
  })

  it("reports optimal with correct avg delivery (placed-time fallback) when all orders for a network completed with no tracking rows", async () => {
    const rows = [
      order({ id: "m1", network: "MTN", status: "completed", created_at: "2026-09-27T10:00:00.000Z", updated_at: "2026-09-27T10:10:00.000Z" }),
      order({ id: "m2", network: "MTN", status: "completed", created_at: "2026-09-27T10:00:00.000Z", updated_at: "2026-09-27T10:20:00.000Z" }),
    ]
    const supabase = createFakeSupabase({ orders: rows })
    const result = await getNetworkHealth(supabase)
    const mtn = result.find((r) => r.network === "MTN")!
    expect(mtn.status).toBe("optimal")
    expect(mtn.uptimePercent).toBe(100)
    expect(mtn.avgDeliveryMinutes).toBe(15) // avg of 10 and 20
    expect(mtn.sampleSize).toBe(2)
  })

  it("uses dispatch time (not placement) for avgDeliveryMinutes when tracking rows exist", async () => {
    const rows = [
      order({ id: "m1", network: "MTN", status: "completed", created_at: "2026-09-27T10:00:00.000Z", updated_at: "2026-09-27T10:30:00.000Z" }),
    ]
    // Placed at 10:00, dispatched at 10:20 -> real delivery time is 10m, not the
    // 30m that placed->completed would suggest.
    const track = [tracking({ order_id: "m1", created_at: "2026-09-27T10:20:00.000Z" })]
    const supabase = createFakeSupabase({ orders: rows }, track)
    const result = await getNetworkHealth(supabase)
    const mtn = result.find((r) => r.network === "MTN")!
    expect(mtn.avgDeliveryMinutes).toBe(10)
  })

  it("computes correct uptime percent from a mix of completed/failed, excluding pending from the denominator", async () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => order({ id: `c${i}`, network: "Telecel", status: "completed" })),
      ...Array.from({ length: 2 }, (_, i) => order({ id: `f${i}`, network: "Telecel", status: "failed" })),
      order({ id: "pending-1", network: "Telecel", status: "pending" }), // must NOT count in the denominator
    ]
    const supabase = createFakeSupabase({ orders: rows })
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
    const supabase = createFakeSupabase({ orders: rows })
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
    const supabase = createFakeSupabase({ orders: rows })
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
    const supabase = createFakeSupabase({ orders: rows })
    const result = await getNetworkHealth(supabase)
    const mtn = result.find((r) => r.network === "MTN")!
    expect(mtn.avgDeliveryMinutes).toBe(10)
    expect(mtn.sampleSize).toBe(2) // both count toward uptime...
    expect(mtn.uptimePercent).toBe(50) // ...but only the completed one feeds avgDeliveryMinutes
  })

  it("returns all four networks in the fixed HEALTH_NETWORKS order", async () => {
    const supabase = createFakeSupabase({})
    const result = await getNetworkHealth(supabase)
    expect(result.map((r) => r.network)).toEqual([...HEALTH_NETWORKS])
  })

  // --- Cross-table aggregation (the actual bug this expansion fixes) ---

  it("counts AT-iShare/AT-BigTime orders sitting in USSD-shop/USSD/shop tables, not just the dashboard orders table", async () => {
    const supabase = createFakeSupabase({
      orders: [], // nothing in the dashboard table for these networks
      ussd_shop_orders: [
        order({ id: "us1", network: "at-ishare", order_status: "completed", payment_status: "completed", status: undefined }),
      ],
      ussd_orders: [
        order({ id: "u1", network: "AT - BigTime", order_status: "completed", payment_status: "completed", status: undefined }),
      ],
      shop_orders: [
        order({ id: "s1", network: "AT - BigTime", order_status: "completed", payment_status: "completed", status: undefined }),
      ],
    })
    const result = await getNetworkHealth(supabase)
    const ishare = result.find((r) => r.network === "AT - iShare")!
    const bigtime = result.find((r) => r.network === "AT - BigTime")!
    expect(ishare.sampleSize).toBe(1)
    expect(ishare.status).toBe("optimal")
    expect(bigtime.sampleSize).toBe(2)
    expect(bigtime.status).toBe("optimal")
  })

  it("excludes shop/ussd/ussd_shop rows whose payment_status isn't completed, even if order_status says completed", async () => {
    // An abandoned checkout: the customer never actually paid, but something
    // set order_status to "completed" in error, or it's stale. This must not
    // count as a real (successful OR failed) fulfillment attempt.
    const supabase = createFakeSupabase({
      shop_orders: [
        order({ id: "abandoned-1", network: "MTN", order_status: "completed", payment_status: "pending", status: undefined }),
      ],
    })
    const result = await getNetworkHealth(supabase)
    const mtn = result.find((r) => r.network === "MTN")!
    expect(mtn.sampleSize).toBe(0)
    expect(mtn.status).toBe("no_data")
  })

  it("resolves dispatch time correctly per source table using that table's own tracking id column", async () => {
    // A shop_orders row's tracking join key is shop_order_id, not order_id —
    // if the wrong column were used, this dispatch override would silently
    // never apply and the test would see placed-time (20m) instead of 5m.
    const rows = {
      shop_orders: [
        order({ id: "shop-1", network: "MTN", order_status: "completed", payment_status: "completed", status: undefined, created_at: "2026-09-27T10:00:00.000Z", updated_at: "2026-09-27T10:20:00.000Z" }),
      ],
    }
    const track = [tracking({ shop_order_id: "shop-1", order_type: "shop", created_at: "2026-09-27T10:15:00.000Z" })]
    const supabase = createFakeSupabase(rows, track)
    const result = await getNetworkHealth(supabase)
    const mtn = result.find((r) => r.network === "MTN")!
    expect(mtn.avgDeliveryMinutes).toBe(5) // dispatch(10:15) -> completed(10:20)
  })

  it("still counts a resolved row toward uptime even when updated_at is missing, just excludes it from the average", async () => {
    const rows = [
      order({ id: "no-updated-at", network: "MTN", status: "completed", updated_at: null }),
      order({ id: "normal", network: "MTN", status: "completed", created_at: "2026-09-27T10:00:00.000Z", updated_at: "2026-09-27T10:10:00.000Z" }),
    ]
    const supabase = createFakeSupabase({ orders: rows })
    const result = await getNetworkHealth(supabase)
    const mtn = result.find((r) => r.network === "MTN")!
    expect(mtn.sampleSize).toBe(2)
    expect(mtn.uptimePercent).toBe(100)
    expect(mtn.avgDeliveryMinutes).toBe(10) // only "normal" contributes
  })
})
