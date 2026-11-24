// Browser-safe helpers for the Report tab: month range rules (same 24-month cap as the route) and profit wording.
import type { ProfitCell, ReportBy } from "./report"

export const REPORT_MAX_MONTHS = 24

export interface MonthRange {
  /** YYYY-MM (input type="month") */
  from: string
  to: string
}

const MONTH_RE = /^(\d{4})-(\d{2})$/
const pad = (n: number) => String(n).padStart(2, "0")

export function defaultRange(now: Date): MonthRange {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const start = new Date(Date.UTC(y, m - 2, 1))
  return { from: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}`, to: `${y}-${pad(m + 1)}` }
}

function parseMonth(v: string): { y: number; m: number } | null {
  const x = MONTH_RE.exec(v)
  if (!x) return null
  const y = Number(x[1])
  const m = Number(x[2])
  return m >= 1 && m <= 12 ? { y, m } : null
}

/** The report query for a month range: first day of the start month to the last day of the end month. */
export function rangeToQuery(range: MonthRange, by: ReportBy, _now: Date): { ok: true; query: string } | { ok: false; error: string } {
  const a = parseMonth(range.from)
  const b = parseMonth(range.to)
  if (!a || !b) return { ok: false, error: "Choose a start and an end month." }
  const span = b.y * 12 + b.m - (a.y * 12 + a.m) + 1
  if (span < 1) return { ok: false, error: "The start month must be on or before the end month." }
  if (span > REPORT_MAX_MONTHS) return { ok: false, error: `Choose at most ${REPORT_MAX_MONTHS} months.` }
  const lastDay = new Date(Date.UTC(b.y, b.m, 0)).getUTCDate()
  return { ok: true, query: `from=${a.y}-${pad(a.m)}-01&to=${b.y}-${pad(b.m)}-${pad(lastDay)}&by=${by}` }
}

const ghs = (n: number) => `GHS ${n.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Profit is a number only where a cost is set; an uncosted order is never valued. */
export function profitText(c: ProfitCell): { text: string; partial: boolean } {
  if (c.kind === "none") return { text: "No cost set", partial: false }
  if (c.kind === "partial") return { text: `${ghs(c.profit)} on ${c.costed} of ${c.of} orders`, partial: true }
  return { text: ghs(c.profit), partial: false }
}

export { ghs as formatGhs }
