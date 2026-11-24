import { describe, it, expect } from "vitest"
import { toCsv } from "./csv"
import type { ReportRow } from "./report"

const r = (o: Partial<ReportRow> = {}): ReportRow => ({
  month: "2026-11", userId: "u1", developer: "Ama Mensah", email: "ama@example.com", product: "MTN",
  orders: 10, revenue: 100, costedOrders: 10, costedRevenue: 100, costTotal: 80, ...o,
})

describe("toCsv", () => {
  it("header and BOM; commas, quotes and newlines quoted", () => {
    const csv = toCsv([r({ developer: 'Ama, "Boss"\nMensah' })])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const lines = csv.slice(1).split("\r\n")
    expect(lines[0]).toBe("Month,Developer,Email,Product,Orders,Revenue (GHS),Orders with a cost,Cost (GHS),Profit (GHS),Profit note")
    expect(csv).toContain('"Ama, ""Boss""\nMensah"')
    expect(lines[lines.length - 1]).toBe("")
  })
  it("cells starting = + - @ tab CR are prefixed with '", () => {
    for (const bad of ["=cmd()", "+1", "-1+2", "@SUM(A1)", "\tx", "\rx"]) {
      const csv = toCsv([r({ developer: bad })])
      const row = csv.slice(1).split("\r\n")[1]
      expect(row).toMatch(/^2026-11,"?'/)
    }
  })
  it("numbers are not prefixed (a negative profit stays a number)", () => {
    const row = toCsv([r({ costTotal: 120 })]).slice(1).split("\r\n")[1]
    expect(row.endsWith(",-20.00,")).toBe(true)
  })
  it("profit column: empty with 'No cost set' when uncosted; partial says how many orders were costed", () => {
    const none = toCsv([r({ costedOrders: 0, costedRevenue: 0, costTotal: 0 })]).slice(1).split("\r\n")[1]
    expect(none.endsWith(",,No cost set")).toBe(true)
    const part = toCsv([r({ costedOrders: 4, costedRevenue: 40, costTotal: 30 })]).slice(1).split("\r\n")[1]
    expect(part.endsWith(",10.00,Cost set for 4 of 10 orders")).toBe(true)
  })
  it("no cost-table or column name appears in the file text", () => {
    const csv = toCsv([r(), r({ costedOrders: 0 })]).toLowerCase()
    for (const w of ["package_costs", "cost_total", "costed_revenue", "costed_orders", "user_id", "api_orders", "package_id"]) {
      expect(csv).not.toContain(w)
    }
  })
})
