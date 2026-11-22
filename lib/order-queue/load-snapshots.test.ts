import { describe, it, expect } from "vitest"
import { loadSnapshots, normalizeNetwork, ORDER_TABLES } from "./load-snapshots"
import { makeFakeDb } from "./fake-db.test-helper"

const T = (id: string, extra: Record<string, any>) => ({
  id,
  order_id: null,
  shop_order_id: null,
  api_order_id: null,
  status: "failed",
  mtn_order_id: "ext-1",
  created_at: "2026-11-20T10:00:00Z",
  ...extra,
})

describe("normalizeNetwork", () => {
  it("matches combined_orders_view's labels", () => {
    expect(normalizeNetwork("mtn")).toBe("MTN")
    expect(normalizeNetwork(" MTN ")).toBe("MTN")
    expect(normalizeNetwork("telecel")).toBe("Telecel")
    expect(normalizeNetwork("at - ishare")).toBe("AT - iShare")
    expect(normalizeNetwork("ishare")).toBe("AT - iShare")
    expect(normalizeNetwork("at-ishare")).toBe("AT - iShare")
    expect(normalizeNetwork("AT - BigTime")).toBe("AT - BigTime")
    expect(normalizeNetwork("at-bigtime")).toBe("AT - BigTime")
    expect(normalizeNetwork("AirtelTigo")).toBe("AirtelTigo")
    expect(normalizeNetwork(null)).toBe("")
  })
})

describe("loadSnapshots", () => {
  it("reads each order type from its own table and status column", async () => {
    const db = makeFakeDb({
      orders: [{ id: "b1", status: "pending", network: "mtn" }],
      api_orders: [{ id: "a1", status: "processing", network: "telecel" }],
      shop_orders: [{ id: "s1", order_status: "reversed", network: "MTN", payment_status: "completed" }],
      ussd_orders: [{ id: "u1", order_status: "pending", network: "at-ishare", payment_status: "completed" }],
      ussd_shop_orders: [{ id: "us1", order_status: "completed", network: "MTN", payment_status: "completed" }],
    })
    const m = await loadSnapshots(db as any, [
      { id: "b1", type: "bulk" },
      { id: "a1", type: "api" },
      { id: "s1", type: "shop" },
      { id: "u1", type: "ussd" },
      { id: "us1", type: "ussd_shop" },
    ])
    expect(m.get("b1")).toEqual({ id: "b1", type: "bulk", status: "pending", network: "MTN", latestAttempt: null, hasLiveAttempt: false, queued: false })
    expect(m.get("a1")).toMatchObject({ type: "api", status: "processing", network: "Telecel" })
    expect(m.get("s1")).toMatchObject({ type: "shop", status: "reversed", network: "MTN" })
    expect(m.get("u1")).toMatchObject({ type: "ussd", status: "pending", network: "AT - iShare" })
    expect(m.get("us1")).toMatchObject({ type: "ussd_shop", status: "completed" })
    expect(ORDER_TABLES.shop).toEqual({ table: "shop_orders", statusCol: "order_status", paidCol: "payment_status" })
  })

  it("never selects phone numbers or other order fields", async () => {
    const db = makeFakeDb({ orders: [{ id: "b1", status: "pending", network: "MTN", phone_number: "0241234567" }] })
    await loadSnapshots(db as any, [{ id: "b1", type: "bulk" }])
    for (const c of db.calls.filter((c) => c.kind === "select")) expect(c.cols).not.toMatch(/phone|recipient|email/)
  })

  it("leaves an unpaid shop/ussd order out (it is not a sendable order)", async () => {
    const db = makeFakeDb({
      shop_orders: [{ id: "s1", order_status: "pending", network: "MTN", payment_status: "pending" }],
      ussd_orders: [{ id: "u1", order_status: "pending", network: "MTN", payment_status: "failed" }],
    })
    const m = await loadSnapshots(db as any, [
      { id: "s1", type: "shop" },
      { id: "u1", type: "ussd" },
    ])
    expect(m.has("s1")).toBe(false)
    expect(m.has("u1")).toBe(false)
  })

  it("an order that does not exist in its table is absent", async () => {
    const db = makeFakeDb({ orders: [] })
    const m = await loadSnapshots(db as any, [{ id: "nope", type: "bulk" }])
    expect(m.has("nope")).toBe(false)
  })

  it("latestAttempt is the newest tracking row (created_at desc, id desc)", async () => {
    const db = makeFakeDb({
      orders: [{ id: "b1", status: "processing", network: "MTN" }],
      mtn_fulfillment_tracking: [
        T("t1", { order_id: "b1", status: "failed", mtn_order_id: "x1", created_at: "2026-11-20T10:00:00Z" }),
        T("t3", { order_id: "b1", status: "abandoned", mtn_order_id: "UNKNOWN_9", created_at: "2026-11-21T10:00:00Z" }),
        T("t2", { order_id: "b1", status: "failed", mtn_order_id: "x2", created_at: "2026-11-21T10:00:00Z" }),
      ],
    })
    const m = await loadSnapshots(db as any, [{ id: "b1", type: "bulk" }])
    expect(m.get("b1")!.latestAttempt).toEqual({ status: "abandoned", mtnOrderId: "UNKNOWN_9" })
    expect(m.get("b1")!.hasLiveAttempt).toBe(false)
  })

  it("hasLiveAttempt is true when ANY row is pending/processing/completed with a non-UNKNOWN_ id, even if not the latest", async () => {
    const db = makeFakeDb({
      orders: [{ id: "b1", status: "processing", network: "MTN" }],
      mtn_fulfillment_tracking: [
        T("t1", { order_id: "b1", status: "completed", mtn_order_id: "x1", created_at: "2026-11-19T10:00:00Z" }),
        T("t2", { order_id: "b1", status: "abandoned", mtn_order_id: "UNKNOWN_1", created_at: "2026-11-21T10:00:00Z" }),
      ],
    })
    const m = await loadSnapshots(db as any, [{ id: "b1", type: "bulk" }])
    expect(m.get("b1")!.hasLiveAttempt).toBe(true)
  })

  it("a pending row with an UNKNOWN_ id is not live", async () => {
    const db = makeFakeDb({
      orders: [{ id: "b1", status: "processing", network: "MTN" }],
      mtn_fulfillment_tracking: [T("t1", { order_id: "b1", status: "pending", mtn_order_id: "UNKNOWN_1" })],
    })
    const m = await loadSnapshots(db as any, [{ id: "b1", type: "bulk" }])
    expect(m.get("b1")!.hasLiveAttempt).toBe(false)
  })

  it("finds shop tracking by shop_order_id and api tracking by api_order_id (and legacy order_id rows too)", async () => {
    const db = makeFakeDb({
      shop_orders: [{ id: "s1", order_status: "pending", network: "MTN", payment_status: "completed" }],
      api_orders: [{ id: "a1", status: "pending", network: "MTN" }, { id: "a2", status: "pending", network: "MTN" }],
      mtn_fulfillment_tracking: [
        T("t1", { shop_order_id: "s1", status: "processing", mtn_order_id: "x" }),
        T("t2", { api_order_id: "a1", status: "pending", mtn_order_id: "y" }),
        T("t3", { order_id: "a2", status: "completed", mtn_order_id: "z" }),
      ],
    })
    const m = await loadSnapshots(db as any, [
      { id: "s1", type: "shop" },
      { id: "a1", type: "api" },
      { id: "a2", type: "api" },
    ])
    expect(m.get("s1")!.hasLiveAttempt).toBe(true)
    expect(m.get("a1")!.hasLiveAttempt).toBe(true)
    expect(m.get("a2")!.hasLiveAttempt).toBe(true)
    const shopCol = db.calls.find((c) => c.table === "mtn_fulfillment_tracking" && c.filters.some((f) => f.col === "shop_order_id"))
    expect(shopCol!.filters.find((f) => f.col === "shop_order_id")!.val).toEqual(["s1"])
  })

  it("queued is true only for a pending/processing fulfillment_queue row", async () => {
    const db = makeFakeDb({
      orders: [
        { id: "b1", status: "pending", network: "MTN" },
        { id: "b2", status: "pending", network: "MTN" },
        { id: "b3", status: "pending", network: "MTN" },
      ],
      fulfillment_queue: [
        { id: "q1", order_id: "b1", status: "processing" },
        { id: "q2", order_id: "b2", status: "failed" },
        { id: "q3", order_id: "b2", status: "completed" },
      ],
    })
    const m = await loadSnapshots(db as any, ["b1", "b2", "b3"].map((id) => ({ id, type: "bulk" as const })))
    expect(m.get("b1")!.queued).toBe(true)
    expect(m.get("b2")!.queued).toBe(false)
    expect(m.get("b3")!.queued).toBe(false)
  })

  it("reads in chunks of at most 100 ids", async () => {
    const orders = Array.from({ length: 250 }, (_, i) => ({ id: `b${i}`, status: "pending", network: "MTN" }))
    const db = makeFakeDb({ orders })
    const m = await loadSnapshots(db as any, orders.map((o) => ({ id: o.id, type: "bulk" as const })))
    expect(m.size).toBe(250)
    for (const c of db.calls) for (const f of c.filters) if (f.op === "in" && f.col !== "status") expect(f.val.length).toBeLessThanOrEqual(100)
    expect(db.calls.filter((c) => c.table === "orders").length).toBe(3)
  })

  it("pages through more than 1000 tracking rows so a live attempt is never missed", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) =>
      T(`t${String(i).padStart(5, "0")}`, { order_id: "b1", status: "failed", mtn_order_id: `f${i}` }),
    )
    rows.push(T("t99999", { order_id: "b1", status: "completed", mtn_order_id: "live" }))
    const db = makeFakeDb({ orders: [{ id: "b1", status: "pending", network: "MTN" }], mtn_fulfillment_tracking: rows })
    const m = await loadSnapshots(db as any, [{ id: "b1", type: "bulk" }])
    expect(m.get("b1")!.hasLiveAttempt).toBe(true)
  })

  it("throws when any read fails (fail closed: no snapshot means no send)", async () => {
    const db = makeFakeDb({ orders: [{ id: "b1", status: "pending", network: "MTN" }] })
    db.failSelect = (t) => (t === "mtn_fulfillment_tracking" ? { message: "boom" } : null)
    await expect(loadSnapshots(db as any, [{ id: "b1", type: "bulk" }])).rejects.toThrow()
  })
})
