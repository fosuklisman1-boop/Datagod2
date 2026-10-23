import { describe, it, expect } from "vitest"
import { shapeStats, shapeKeyActivity, parseLogQuery } from "./admin-stats"

const UUID = "123e4567-e89b-12d3-a456-426614174000"

describe("shapeStats", () => {
  it("returns null rates when there are no requests", () => {
    const s = shapeStats(
      { keys: { total: 2, pending: 1, active: 1, revoked: 0 }, requests: 0, ok: 0, failed: 0, avg_latency_ms: null, top: null },
      null
    )
    expect(s.successRate).toBeNull()
    expect(s.avgLatencyMs).toBeNull()
    expect(s.top).toBeNull()
    expect(s.totalKeys).toBe(2)
    expect(s.pendingKeys).toBe(1)
    expect(s.activeKeys).toBe(1)
  })

  it("computes and rounds rates", () => {
    const s = shapeStats(
      { keys: { total: 3, pending: 0, active: 3, revoked: 0 }, requests: 1000, ok: 993, failed: 7, avg_latency_ms: 264.6, top: { user_id: UUID, requests: 400 } },
      { name: "Ama Mensah", email: "ama@example.com" }
    )
    expect(s.requests24h).toBe(1000)
    expect(s.failed24h).toBe(7)
    expect(s.successRate).toBe(99.3)
    expect(s.avgLatencyMs).toBe(265)
    expect(s.top).toEqual({ userId: UUID, name: "Ama Mensah", email: "ama@example.com", requests: 400 })
  })

  it("keeps top with null owner details", () => {
    const s = shapeStats({ requests: 5, ok: 5, failed: 0, top: { user_id: UUID, requests: 5 } }, null)
    expect(s.top).toEqual({ userId: UUID, name: null, email: null, requests: 5 })
  })

  it("maps order attribution fields to numbers (2 dp)", () => {
    const s = shapeStats({ revenue: 96.9, revenue_lifetime: 8806.64, orders: 12, pending_orders: 3 }, null)
    expect(s.revenue24h).toBe(96.9)
    expect(s.revenueLifetime).toBe(8806.64)
    expect(s.orders24h).toBe(12)
    expect(s.pendingOrders24h).toBe(3)
    expect(shapeStats({ revenue: 1.005 + 0.0001, revenue_lifetime: 0 }, null).revenue24h).toBe(1.01)
    expect(shapeStats({ revenue: 0, orders: 0, pending_orders: 0 }, null).revenue24h).toBe(0)
    expect(shapeStats({ revenue: 0, orders: 0, pending_orders: 0 }, null).orders24h).toBe(0)
  })

  it("returns null for absent attribution fields (older function version)", () => {
    const s = shapeStats({ keys: { total: 1 }, requests: 4, ok: 4, failed: 0 }, null)
    expect(s.revenue24h).toBeNull()
    expect(s.revenueLifetime).toBeNull()
    expect(s.orders24h).toBeNull()
    expect(s.pendingOrders24h).toBeNull()
  })

  it("returns null for malformed, negative or NaN attribution fields", () => {
    for (const bad of [-1, -0.01, NaN, Infinity, "96.9", null, {}, [], true]) {
      const s = shapeStats({ revenue: bad, revenue_lifetime: bad, orders: bad, pending_orders: bad }, null)
      expect(s.revenue24h).toBeNull()
      expect(s.revenueLifetime).toBeNull()
      expect(s.orders24h).toBeNull()
      expect(s.pendingOrders24h).toBeNull()
    }
  })

  it("never throws on malformed input and nulls attribution when absent", () => {
    for (const raw of [null, undefined, "x", 5, [], { keys: "bad", requests: -3, ok: "a", failed: -1, avg_latency_ms: -5, top: "nope" }]) {
      const s = shapeStats(raw, null)
      expect(s.totalKeys).toBe(0)
      expect(s.requests24h).toBe(0)
      expect(s.failed24h).toBe(0)
      expect(s.successRate).toBeNull()
      expect(s.avgLatencyMs).toBeNull()
      expect(s.top).toBeNull()
      expect(s.revenue24h).toBeNull()
      expect(s.revenueLifetime).toBeNull()
      expect(s.orders24h).toBeNull()
      expect(s.pendingOrders24h).toBeNull()
    }
  })
})

describe("shapeKeyActivity", () => {
  it("maps spent, orders and pending to numbers when present", () => {
    const a = shapeKeyActivity({ requests: 5, ok: 5, failed: 0, spent: 96.9, orders: 8, pending: 2 })
    expect(a.spent).toBe(96.9)
    expect(a.orders).toBe(8)
    expect(a.pending).toBe(2)
    const z = shapeKeyActivity({ spent: 0, orders: 0, pending: 0 })
    expect([z.spent, z.orders, z.pending]).toEqual([0, 0, 0])
  })

  it("returns null for absent or malformed spent, orders and pending", () => {
    for (const raw of [{}, null, { spent: -1, orders: NaN, pending: "2" }, { spent: Infinity, orders: -3, pending: {} }]) {
      const a = shapeKeyActivity(raw)
      expect(a.spent).toBeNull()
      expect(a.orders).toBeNull()
      expect(a.pending).toBeNull()
    }
  })

  it("shapes a normal row", () => {
    const a = shapeKeyActivity({ requests: 1000, ok: 993, failed: 7, avg_latency_ms: 264.6, last_used_at: "2026-10-22T09:00:00Z" })
    expect(a).toEqual({
      requests: 1000,
      ok: 993,
      failed: 7,
      successRate: 99.3,
      avgLatencyMs: 265,
      lastUsedAt: "2026-10-22T09:00:00Z",
      spent: null,
      orders: null,
      pending: null,
    })
  })

  it("handles zero and malformed input", () => {
    for (const raw of [null, "x", { requests: 0, ok: 0, failed: 0, avg_latency_ms: null, last_used_at: null }, { requests: -1, last_used_at: 5 }]) {
      const a = shapeKeyActivity(raw)
      expect(a.requests).toBe(0)
      expect(a.successRate).toBeNull()
      expect(a.avgLatencyMs).toBeNull()
      expect(a.lastUsedAt).toBeNull()
      expect(a.spent).toBeNull()
      expect(a.orders).toBeNull()
      expect(a.pending).toBeNull()
    }
  })
})

describe("parseLogQuery", () => {
  const parse = (q: string) => parseLogQuery(new URLSearchParams(q))

  it("applies defaults", () => {
    expect(parse("")).toEqual({ ok: true, value: { limit: 100, offset: 0 } })
  })

  it("clamps limit to 200", () => {
    const r = parse("limit=5000")
    expect(r.ok && r.value.limit).toBe(200)
  })

  it("accepts valid filters", () => {
    const r = parse(`keyId=${UUID}&userId=${UUID}&statusClass=client_error&since=2026-10-01T00:00:00Z&until=2026-10-22&endpoint=/api/v2/wallet/balance&limit=10&offset=20`)
    expect(r).toEqual({
      ok: true,
      value: {
        keyId: UUID,
        userId: UUID,
        statusClass: "client_error",
        since: "2026-10-01T00:00:00Z",
        until: "2026-10-22",
        endpoint: "/api/v2/wallet/balance",
        limit: 10,
        offset: 20,
      },
    })
  })

  it("rejects bad values", () => {
    expect(parse("offset=-1").ok).toBe(false)
    expect(parse("keyId=not-a-uuid").ok).toBe(false)
    expect(parse("userId=not-a-uuid").ok).toBe(false)
    expect(parse("statusClass=bogus").ok).toBe(false)
    expect(parse("since=yesterday").ok).toBe(false)
    expect(parse("until=2026-13-45").ok).toBe(false)
    expect(parse("limit=abc").ok).toBe(false)
  })

  it("bounds offset", () => {
    expect(parse("offset=100000").ok).toBe(true)
    expect(parse("offset=100001").ok).toBe(false)
    expect(parse(`offset=${"9".repeat(309)}`).ok).toBe(false)
    expect(parse("offset=9007199254740993").ok).toBe(false)
  })

  it("rejects dates that roll over or lack a timezone", () => {
    expect(parse("since=2026-02-31").ok).toBe(false)
    expect(parse("since=2026-04-31T00:00:00Z").ok).toBe(false)
    expect(parse("since=2026-10-01T25:00:00Z").ok).toBe(false)
    expect(parse("since=2026-10-01T10:00:00").ok).toBe(false)
    expect(parse("since=2026-10-01T10:00").ok).toBe(false)
    expect(parse("since=2028-02-29").ok).toBe(true)
    expect(parse("since=2026-10-01T10:00:00.123%2B02:00").ok).toBe(true)
    expect(parse("since=2026-10-01T10:00:00Z").ok).toBe(true)
  })
})
