import { createElement } from "react"
import { readFileSync } from "node:fs"
import { describe, it, expect, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))

import { defaultRange, rangeToQuery, profitText } from "./report-view"
import { groupReport, type ReportGroup, type ReportRow } from "./report"
import { ReportTabView } from "@/components/admin/api-keys/ReportTab"

const NOW = new Date("2026-11-24T08:00:00Z")
const noop = () => {}
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)
const r = (o: Partial<ReportRow> = {}): ReportRow => ({
  month: "2026-11", userId: "u1", developer: "Ama Mensah", email: "a@x.com", product: "MTN",
  orders: 10, revenue: 100, costedOrders: 10, costedRevenue: 100, costTotal: 80, ...o,
})

describe("range picker rules", () => {
  it("defaults to the last 3 months and refuses more than 24", () => {
    expect(defaultRange(NOW)).toEqual({ from: "2026-09", to: "2026-11" })
    expect(rangeToQuery({ from: "2026-09", to: "2026-11" }, "developer", NOW)).toEqual({ ok: true, query: "from=2026-09-01&to=2026-11-30&by=developer" })
    expect(rangeToQuery({ from: "2024-12", to: "2026-11" }, "product", NOW).ok).toBe(true)
    const tooLong = rangeToQuery({ from: "2024-11", to: "2026-11" }, "product", NOW)
    expect(tooLong).toEqual({ ok: false, error: "Choose at most 24 months." })
    expect(rangeToQuery({ from: "2026-11", to: "2026-09" }, "month", NOW)).toEqual({ ok: false, error: "The start month must be on or before the end month." })
    expect(rangeToQuery({ from: "", to: "2026-09" }, "month", NOW).ok).toBe(false)
  })
  it("February ends on the right day", () => {
    expect(rangeToQuery({ from: "2026-02", to: "2026-02" }, "month", NOW)).toEqual({ ok: true, query: "from=2026-02-01&to=2026-02-28&by=month" })
  })
})

describe("profitText", () => {
  it("none -> no cost set; partial -> GHS x on n of m orders; full -> plain value; never a number for none", () => {
    expect(profitText({ kind: "none" })).toEqual({ text: "No cost set", partial: false })
    expect(profitText({ kind: "partial", profit: 10, costed: 4, of: 10 })).toEqual({ text: "GHS 10.00 on 4 of 10 orders", partial: true })
    expect(profitText({ kind: "full", profit: 20 })).toEqual({ text: "GHS 20.00", partial: false })
    expect(/\d/.test(profitText({ kind: "none" }).text)).toBe(false)
  })
})

const view = (groups: ReportGroup[], o: Record<string, unknown> = {}) =>
  html(
    createElement(ReportTabView, {
      range: { from: "2026-09", to: "2026-11" }, by: "developer", rangeError: null,
      data: { groups, totals: groups[0] ?? null, other: [{ month: "2026-11", product: "Airtime", orders: 7 }], otherCapped: false },
      loading: false, error: null, exporting: false, exportError: null,
      onRange: noop, onBy: noop, onExport: noop, onRetry: noop, ...o,
    }),
  )

describe("ReportTabView", () => {
  const groups = groupReport([r(), r({ userId: "u2", developer: "Kofi", costedOrders: 0, costedRevenue: 0, costTotal: 0 })], "developer")
  it("group-by tabs; grouped rows; profit cells; partial badge", () => {
    const out = view(groupReport([r(), r({ userId: "u2", developer: "Kofi", costedOrders: 3, costedRevenue: 30, costTotal: 20 })], "developer"))
    for (const t of ["Developer", "Product", "Month", "Ama Mensah", "Kofi", "GHS 20.00", "GHS 10.00 on 3 of 10 orders", "partial"]) expect(out).toContain(t)
  })
  it("no cost set text for uncosted groups", () => {
    expect(view(groups)).toContain("No cost set")
  })
  it("Commission and other products: counts and not tracked revenue", () => {
    const out = view(groups)
    expect(out).toContain("Commission and other products")
    expect(out).toContain("Airtime")
    expect(out).toMatch(/not tracked/i)
  })
  it("range error shown; empty state; load failure has Retry", () => {
    expect(view(groups, { rangeError: "Choose at most 24 months." })).toContain("Choose at most 24 months.")
    expect(view([], { data: { groups: [], totals: null, other: [], otherCapped: false } })).toMatch(/No API orders in this range/)
    const failed = view([], { data: null, error: "Not set up yet" })
    expect(failed).toContain("Retry")
    expect(failed).toContain('role="alert"')
  })
  it("layout: summary beside the table on lg; table scrolls inside its card", () => {
    const out = view(groups)
    expect(out).toMatch(/lg:grid-cols-\[/)
    expect(out).toContain("overflow-x-auto")
    expect(out).toContain("Export CSV")
  })
})

describe("export", () => {
  it("downloads through an authenticated fetch (blob), not a bare link", () => {
    const src = readFileSync("components/admin/api-keys/ReportTab.tsx", "utf8")
    expect(src).toContain("adminDownload")
    expect(src).not.toMatch(/href=\{?[`"'][^`"']*format=csv/)
    const helper = readFileSync("components/admin/api-keys/admin-fetch.ts", "utf8")
    expect(helper).toMatch(/export async function adminDownload/)
    expect(helper).toContain("Authorization")
    expect(helper).toContain(".blob()")
  })
})
