import { describe, it, expect } from "vitest"
import { profitCell, groupReport, parseReportQuery, shapeReportRows, REPORT_ROW_LIMIT, type ReportRow } from "./report"

const r = (o: Partial<ReportRow> = {}): ReportRow => ({
  month: "2026-11", userId: "u1", developer: "Ama Mensah", email: "ama@example.com", product: "MTN",
  orders: 10, revenue: 100, costedOrders: 10, costedRevenue: 100, costTotal: 80, ...o,
})

describe("profitCell", () => {
  it("costedOrders 0 -> none; costed < orders -> partial with counts; equal -> full; never returns a number when none", () => {
    expect(profitCell(r({ costedOrders: 0, costedRevenue: 0, costTotal: 0 }))).toEqual({ kind: "none" })
    expect(profitCell(r({ costedOrders: 4, costedRevenue: 40, costTotal: 30 }))).toEqual({ kind: "partial", profit: 10, costed: 4, of: 10 })
    expect(profitCell(r())).toEqual({ kind: "full", profit: 20 })
    expect("profit" in profitCell(r({ costedOrders: 0 }))).toBe(false)
  })
  it("a row with revenue but no cost never yields profit = revenue (no default cost)", () => {
    const c = profitCell(r({ revenue: 500, costedOrders: 0, costedRevenue: 0, costTotal: 0 }))
    expect(c.kind).toBe("none")
    expect(JSON.stringify(c)).not.toContain("500")
  })
  it("rounds money to 2 decimals", () => {
    expect(profitCell(r({ costedRevenue: 10.105, revenue: 10.105, costTotal: 3.1 }))).toEqual({ kind: "full", profit: 7.01 })
  })
})

describe("groupReport", () => {
  it("group totals equal the sum of rows; mixed costed/uncosted group is partial", () => {
    const rows = [r(), r({ product: "Telecel", orders: 5, revenue: 50, costedOrders: 0, costedRevenue: 0, costTotal: 0 }), r({ userId: "u2", developer: "Kofi" })]
    const byDev = groupReport(rows, "developer")
    const ama = byDev.find((g) => g.key === "u1")!
    expect(ama).toMatchObject({ label: "Ama Mensah", orders: 15, revenue: 150, costedOrders: 10, costTotal: 80 })
    expect(ama.profit).toEqual({ kind: "partial", profit: 20, costed: 10, of: 15 })
    const total = byDev.reduce((s, g) => s + g.revenue, 0)
    expect(total).toBe(rows.reduce((s, x) => s + x.revenue, 0))
    const byProduct = groupReport(rows, "product")
    expect(byProduct.map((g) => g.key).sort()).toEqual(["MTN", "Telecel"])
    expect(byProduct.find((g) => g.key === "Telecel")!.profit).toEqual({ kind: "none" })
    expect(groupReport(rows, "month")).toHaveLength(1)
  })
  it("sorted by revenue, highest first", () => {
    const g = groupReport([r({ userId: "a", revenue: 5, costedRevenue: 5 }), r({ userId: "b", revenue: 50, costedRevenue: 50 })], "developer")
    expect(g.map((x) => x.key)).toEqual(["b", "a"])
  })
})

describe("parseReportQuery", () => {
  const NOW = new Date("2026-11-24T08:00:00Z")
  it("report range: 25 months -> error; from after to -> error; default last 3 months", () => {
    expect(parseReportQuery(new URLSearchParams("from=2024-10-01&to=2026-11-01"), NOW).ok).toBe(false)
    expect(parseReportQuery(new URLSearchParams("from=2024-12-01&to=2026-11-30"), NOW).ok).toBe(true)
    expect(parseReportQuery(new URLSearchParams("from=2026-11-10&to=2026-11-01"), NOW).ok).toBe(false)
    const d = parseReportQuery(new URLSearchParams(""), NOW)
    if (!d.ok) throw new Error("expected ok")
    expect(d.from.toISOString()).toBe("2026-09-01T00:00:00.000Z")
    expect(d.to.toISOString()).toBe("2026-11-25T00:00:00.000Z")
    expect(d.by).toBe("developer")
    expect(d.csv).toBe(false)
  })
  it("to is inclusive (sent to SQL as the next midnight); by and format are a closed set", () => {
    const q = parseReportQuery(new URLSearchParams("from=2026-10-01&to=2026-10-31&by=product&format=csv"), NOW)
    if (!q.ok) throw new Error("expected ok")
    expect(q.to.toISOString()).toBe("2026-11-01T00:00:00.000Z")
    expect(q.by).toBe("product")
    expect(q.csv).toBe(true)
    expect(parseReportQuery(new URLSearchParams("by=password"), NOW).ok).toBe(false)
    expect(parseReportQuery(new URLSearchParams("from=2026-02-31"), NOW).ok).toBe(false)
    expect(parseReportQuery(new URLSearchParams("from=yesterday"), NOW).ok).toBe(false)
  })
})

describe("shapeReportRows", () => {
  it("maps SQL fields, tolerates junk, and flags more than the limit", () => {
    const raw = [
      { month: "2026-11", user_id: "u1", developer: null, email: null, product: "MTN", orders: "3", revenue: "30.5", costed_orders: 1, costed_revenue: 10, cost_total: 8 },
      null,
      "junk",
    ]
    const out = shapeReportRows(raw)
    expect(out.tooMany).toBe(false)
    expect(out.rows).toEqual([
      { month: "2026-11", userId: "u1", developer: "Unknown developer", email: null, product: "MTN", orders: 3, revenue: 30.5, costedOrders: 1, costedRevenue: 10, costTotal: 8 },
    ])
    const big = Array.from({ length: REPORT_ROW_LIMIT + 1 }, () => raw[0])
    expect(shapeReportRows(big).tooMany).toBe(true)
    expect(shapeReportRows({}).rows).toEqual([])
  })
})
