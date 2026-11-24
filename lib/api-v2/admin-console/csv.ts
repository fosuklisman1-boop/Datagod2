/**
 * CSV download of the business report. UTF-8 BOM (so Excel reads Twi and accented names), CRLF rows, RFC 4180
 * quoting, and a formula-injection guard: a text cell starting with = + - @ tab or CR is prefixed with ' so a
 * spreadsheet never runs it. Numbers are written as plain numbers and are never prefixed. Column labels are words
 * for people; no table or column name appears in the file.
 */
import { profitCell, type ReportRow } from "./report"

const BOM = String.fromCharCode(0xfeff)
const TAB = String.fromCharCode(9)
const CR = String.fromCharCode(13)
const FORMULA_START = new Set(["=", "+", "-", "@", TAB, CR])

const HEADER = ["Month", "Developer", "Email", "Product", "Orders", "Revenue (GHS)", "Orders with a cost", "Cost (GHS)", "Profit (GHS)", "Profit note"]

function text(v: string | null): string {
  let s = v ?? ""
  if (s && FORMULA_START.has(s[0])) s = "'" + s
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

const amount = (n: number) => (Math.round(n * 100) / 100).toFixed(2)

export function toCsv(rows: ReportRow[]): string {
  const lines = [HEADER.join(",")]
  for (const r of rows) {
    const p = profitCell(r)
    const profit = p.kind === "none" ? "" : amount(p.profit)
    const note = p.kind === "none" ? "No cost set" : p.kind === "partial" ? `Cost set for ${p.costed} of ${p.of} orders` : ""
    lines.push(
      [
        text(r.month),
        text(r.developer),
        text(r.email),
        text(r.product),
        String(r.orders),
        amount(r.revenue),
        String(r.costedOrders),
        p.kind === "none" ? "" : amount(r.costTotal),
        profit,
        text(note),
      ].join(","),
    )
  }
  return BOM + lines.join("\r\n") + "\r\n"
}
