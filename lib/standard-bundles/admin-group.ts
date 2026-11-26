/**
 * Admin Standard Bundles orders list: one card per Special purchase (N unit orders sharing special_group_id).
 * Pure, client-safe. The customer page has its own grouping (special-ui.ts groupBundleOrders).
 */
import { formatSpecialGb, parseBundleMb } from "./special-format"

export interface AdminGroupable {
  id: string
  status: string
  amount: number
  bundle_display: string
  special_group_id?: string | null
  special_index?: number | null
  /** Unit count of the whole group (from the server); null when it could not be read. */
  special_size?: number | null
}

export type AdminLine<R extends AdminGroupable> =
  | { kind: "single"; row: R }
  | { kind: "special"; groupId: string; units: R[] }

/** Rows → lines. A group's card sits where its first unit appeared; units sorted by special_index. */
export function groupAdminRows<R extends AdminGroupable>(rows: R[]): AdminLine<R>[] {
  const lines: AdminLine<R>[] = []
  const groups = new Map<string, R[]>()
  for (const r of rows) {
    const g = r.special_group_id
    if (!g) { lines.push({ kind: "single", row: r }); continue }
    const units = groups.get(g)
    if (units) { units.push(r); continue }
    const fresh = [r]
    groups.set(g, fresh)
    lines.push({ kind: "special", groupId: g, units: fresh })
  }
  for (const units of groups.values()) units.sort((a, b) => (a.special_index ?? 0) - (b.special_index ?? 0))
  return lines
}

export interface SpecialSummary {
  /** Units in the whole purchase (server count; the page's units when unknown). */
  size: number
  delivered: number
  /** "5/5 delivered", "2/5 delivered · 3 sending", "1/3 delivered · 1 failed · 1 refunded" */
  label: string
  /** A status key the page already styles: completed | processing | failed | partial. */
  tone: "completed" | "processing" | "failed" | "partial"
  /** size × unit price (every unit of a group costs the same). */
  total: number
  /** "Special 2.03GB (5 × 406.89MB)" */
  title: string
  /** Units of this purchase not on the page (paging or a status filter left them out). */
  missingFromPage: number
}

export function specialGroupSummary(units: AdminGroupable[]): SpecialSummary {
  const first = units[0]
  const known = units.find(u => typeof u.special_size === "number" && u.special_size > 0)?.special_size
  const size = Math.max(known ?? 0, units.length)
  const count = (s: string) => units.filter(u => u.status === s).length
  const delivered = count("completed")
  const sending = count("pending") + count("processing")
  const failed = count("failed")
  const refunded = count("refunded")
  const missingFromPage = size - units.length

  const parts = [`${delivered}/${size} delivered`]
  if (sending) parts.push(`${sending} sending`)
  if (failed) parts.push(`${failed} failed`)
  if (refunded) parts.push(`${refunded} refunded`)

  const tone: SpecialSummary["tone"] =
    failed || refunded ? "failed"
    : sending ? "processing"
    : delivered === size ? "completed"
    : "partial"

  const mb = parseBundleMb(first?.bundle_display ?? "", "")
  const breakdown = `${size} × ${first?.bundle_display ?? "unit"}`
  return {
    size,
    delivered,
    label: parts.join(" · "),
    tone,
    total: (Math.round(Number(first?.amount ?? 0) * 100) * size) / 100,
    title: mb === null ? `Special ${breakdown}` : `Special ${formatSpecialGb(mb * size)} (${breakdown})`,
    missingFromPage,
  }
}
