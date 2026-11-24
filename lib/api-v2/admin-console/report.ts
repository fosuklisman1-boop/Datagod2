import { toCsv } from "./csv"
import { callRead, readFailure } from "./read-common"
import { SERVICES } from "@/lib/api-v2/services"
import type { RpcClient, WriteResult } from "./write-common"

/**
 * Business report (spec 8): data orders placed through v2 keys, by month, developer and product (network), from
 * api_v2_business_report. Profit is shown only where an order has a cost set (admin cost table); an order with no cost
 * is NEVER valued at zero cost, so a group is "none", "partial" (with counts) or "full". Never invent a cost.
 */

export const REPORT_ROW_LIMIT = 20000
export const REPORT_MAX_MONTHS = 24

export interface ReportRow {
  month: string
  userId: string
  developer: string
  email: string | null
  product: string
  orders: number
  revenue: number
  costedOrders: number
  costedRevenue: number
  costTotal: number
}

export type ProfitCell = { kind: "none" } | { kind: "partial"; profit: number; costed: number; of: number } | { kind: "full"; profit: number }

export interface ReportGroup {
  key: string
  label: string
  orders: number
  revenue: number
  costedOrders: number
  costedRevenue: number
  costTotal: number
  profit: ProfitCell
}

export type ReportBy = "developer" | "product" | "month"

const money = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function profitCell(r: Pick<ReportRow, "orders" | "costedOrders" | "costedRevenue" | "costTotal">): ProfitCell {
  if (!(r.costedOrders > 0)) return { kind: "none" }
  const profit = money(r.costedRevenue - r.costTotal)
  if (r.costedOrders < r.orders) return { kind: "partial", profit, costed: r.costedOrders, of: r.orders }
  return { kind: "full", profit }
}

export function shapeReportRows(raw: unknown): { rows: ReportRow[]; tooMany: boolean } {
  if (!Array.isArray(raw)) return { rows: [], tooMany: false }
  if (raw.length > REPORT_ROW_LIMIT) return { rows: [], tooMany: true }
  const rows: ReportRow[] = []
  for (const x of raw) {
    if (!x || typeof x !== "object") continue
    const o = x as Record<string, unknown>
    if (typeof o.month !== "string" || typeof o.user_id !== "string") continue
    rows.push({
      month: o.month,
      userId: o.user_id,
      developer: typeof o.developer === "string" && o.developer.trim() ? o.developer : "Unknown developer",
      email: typeof o.email === "string" ? o.email : null,
      product: typeof o.product === "string" && o.product ? o.product : "Unknown",
      orders: num(o.orders),
      revenue: num(o.revenue),
      costedOrders: num(o.costed_orders),
      costedRevenue: num(o.costed_revenue),
      costTotal: num(o.cost_total),
    })
  }
  return { rows, tooMany: false }
}

export function groupReport(rows: ReportRow[], by: ReportBy): ReportGroup[] {
  const groups = new Map<string, Omit<ReportGroup, "profit">>()
  for (const r of rows) {
    const key = by === "developer" ? r.userId : by === "product" ? r.product : r.month
    const label = by === "developer" ? r.developer : key
    const g = groups.get(key) ?? { key, label, orders: 0, revenue: 0, costedOrders: 0, costedRevenue: 0, costTotal: 0 }
    g.orders += r.orders
    g.revenue += r.revenue
    g.costedOrders += r.costedOrders
    g.costedRevenue += r.costedRevenue
    g.costTotal += r.costTotal
    groups.set(key, g)
  }
  return [...groups.values()]
    .map((g) => ({ ...g, revenue: money(g.revenue), costedRevenue: money(g.costedRevenue), costTotal: money(g.costTotal), profit: profitCell(g) }))
    .sort((a, b) => b.revenue - a.revenue || a.key.localeCompare(b.key))
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function parseDay(v: string): Date | null {
  const m = DATE_RE.exec(v)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t : null
}

const DAY = 24 * 3600_000

export function parseReportQuery(
  q: URLSearchParams,
  now: Date,
): { ok: true; from: Date; to: Date; by: ReportBy; csv: boolean } | { ok: false; error: string } {
  const byRaw = q.get("by") ?? "developer"
  if (byRaw !== "developer" && byRaw !== "product" && byRaw !== "month") return { ok: false, error: "Group by developer, product or month." }
  const fmt = q.get("format")
  if (fmt !== null && fmt !== "csv" && fmt !== "json") return { ok: false, error: "Format must be csv or json." }

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const fromRaw = q.get("from")
  const toRaw = q.get("to")
  const from = fromRaw ? parseDay(fromRaw) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1))
  const toDay = toRaw ? parseDay(toRaw) : today
  if (!from || !toDay) return { ok: false, error: "Dates must be real days written YYYY-MM-DD." }
  if (toDay.getTime() < from.getTime()) return { ok: false, error: "The start must be on or before the end." }
  const limit = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + REPORT_MAX_MONTHS, from.getUTCDate()))
  if (toDay.getTime() >= limit.getTime()) return { ok: false, error: `Choose at most ${REPORT_MAX_MONTHS} months.` }
  // "to" is inclusive for people; SQL takes a half-open range, so send the next midnight.
  return { ok: true, from, to: new Date(toDay.getTime() + DAY), by: byRaw, csv: fmt === "csv" }
}

// ---------------- loaders used by the routes ----------------

/** Claim kind (api_v2_idempotency.kind) -> the product name people know. Unknown kinds keep their own name. */
const KIND_SERVICE: Record<string, string> = { airtime: "airtime", bill: "bills", bundle: "bundles", results: "results", afa: "afa", sms: "sms" }
const kindLabel = (kind: string) => SERVICES.find((s) => s.id === KIND_SERVICE[kind])?.title ?? kind

export type ReportResult = { kind: "json"; status: number; body: Record<string, unknown> } | { kind: "csv"; csv: string; filename: string }

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

export async function loadReport(client: RpcClient, q: URLSearchParams, now: Date): Promise<ReportResult> {
  const parsed = parseReportQuery(q, now)
  if (!parsed.ok) return { kind: "json", status: 400, body: { error: parsed.error, code: "bad_input" } }
  const { from, to, by, csv } = parsed

  const out = await callRead(client, "api_v2_business_report", { p_from: from.toISOString(), p_to: to.toISOString() })
  if (!out.ok) return { kind: "json", ...out.result }
  const { rows, tooMany } = shapeReportRows(out.data)
  if (tooMany) return { kind: "json", status: 400, body: { error: "Too many rows. Narrow the range.", code: "too_many" } }

  const lastDay = new Date(to.getTime() - DAY)
  if (csv) return { kind: "csv", csv: toCsv(rows), filename: `api-report-${isoDay(from)}-to-${isoDay(lastDay)}.csv` }

  // Commission and other products: counted, never valued (their revenue is not tracked per order).
  let other: { month: string; product: string; orders: number }[] = []
  let otherCapped = false
  try {
    const res = (await client
      .from("api_v2_idempotency")
      .select("kind, created_at")
      .eq("status", "done")
      .gte("created_at", from.toISOString())
      .lt("created_at", to.toISOString())
      .limit(REPORT_ROW_LIMIT + 1)) as { data: unknown; error: unknown }
    if (res.error) {
      readFailure("api_v2_idempotency", res.error)
    } else {
      const list = Array.isArray(res.data) ? res.data : []
      otherCapped = list.length > REPORT_ROW_LIMIT
      const counts = new Map<string, { month: string; product: string; orders: number }>()
      for (const x of list.slice(0, REPORT_ROW_LIMIT)) {
        const o = x as { kind?: unknown; created_at?: unknown }
        if (typeof o?.kind !== "string" || typeof o.created_at !== "string") continue
        const month = o.created_at.slice(0, 7)
        const product = kindLabel(o.kind)
        const k = `${month}|${product}`
        const c = counts.get(k) ?? { month, product, orders: 0 }
        c.orders++
        counts.set(k, c)
      }
      other = [...counts.values()].sort((a, b) => a.month.localeCompare(b.month) || a.product.localeCompare(b.product))
    }
  } catch {
    readFailure("api_v2_idempotency", null)
  }

  const groups = groupReport(rows, by)
  const totals = groupReport(rows.map((r) => ({ ...r, month: "all" })), "month")[0] ?? null
  return {
    kind: "json",
    status: 200,
    body: { from: isoDay(from), to: isoDay(lastDay), by, groups, totals, other, otherCapped, otherRevenue: "not tracked" },
  }
}

const TREND_DAYS = new Set([7, 30, 90])

export async function loadTrend(client: RpcClient, q: URLSearchParams, now: Date): Promise<WriteResult> {
  const asked = Number(q.get("days"))
  const days = TREND_DAYS.has(asked) ? asked : 30
  const out = await callRead(client, "api_v2_overview_trend", { p_since: new Date(now.getTime() - days * DAY).toISOString() })
  if (!out.ok) return out.result
  const points = (Array.isArray(out.data) ? out.data : [])
    .filter((d): d is Record<string, unknown> => !!d && typeof d === "object" && typeof (d as { day?: unknown }).day === "string")
    .map((d) => ({ day: d.day as string, requests: num(d.requests), ok: num(d.ok), failed: num(d.failed), revenue: money(num(d.revenue)) }))
  return { status: 200, body: { days, points } }
}
