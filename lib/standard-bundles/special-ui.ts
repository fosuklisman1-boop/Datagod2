import { quoteForDisplay, type RateEntry } from "@/lib/cashback/display"
import { formatSpecialGb, parseBundleMb } from "./special-format"

/** The `special` block a Special Bundles catalog entry carries (see buildSpecialEntries). */
export interface SpecialInfo { n: number; unitAmount: number; unitDisplay: string }

export interface CardPrice { pay: number; face: number; applied: boolean }

const cents = (n: number) => Math.round(n * 100)

function validSpecial(s: SpecialInfo | null | undefined): s is SpecialInfo {
  return !!s && Number.isInteger(s.n) && s.n > 0 && Number.isFinite(s.unitAmount) && s.unitAmount > 0
}

/**
 * The price a card / buy sheet shows, and the `expectedPay` it sends.
 * - Normal bundle: quoteForDisplay(amount), exactly as before.
 * - Special: n × the per-unit display price (the server floors cashback per unit, so the total is never
 *   quoteForDisplay(n × unitAmount)). Face (struck-through) = n × unitAmount. Summed in cents.
 */
export function bundleCardPrice(b: { amount: number; special?: SpecialInfo | null }, entry: RateEntry | undefined): CardPrice {
  if (validSpecial(b.special)) {
    const { n, unitAmount } = b.special
    const q = quoteForDisplay(unitAmount, entry)
    const unitPayC = cents(q.applied ? q.pay : unitAmount)
    return { pay: (unitPayC * n) / 100, face: (cents(unitAmount) * n) / 100, applied: q.applied }
  }
  const q = quoteForDisplay(b.amount, entry)
  return { pay: q.applied ? q.pay : b.amount, face: b.amount, applied: q.applied }
}

/** "3 × 406.89MB" */
export function specialBreakdown(s: SpecialInfo): string {
  return `${s.n} × ${s.unitDisplay}`
}

export const PART_DELIVERED_LABEL = "Part delivered — we're on it"

/** One status for a Special group: all completed → Completed; any failed (or refunded) → part delivered; else Processing. */
export function specialGroupStatus(statuses: string[]): { label: string; tone: string } {
  if (statuses.length > 0 && statuses.every(s => s === "completed")) return { label: "Completed", tone: "completed" }
  if (statuses.some(s => s === "failed" || s === "refunded")) return { label: PART_DELIVERED_LABEL, tone: "pending" }
  return { label: "Processing", tone: "processing" }
}

/** A row of /api/standard-bundles/orders. */
export interface BundleOrderRow {
  id: string
  reference_code: string
  network: string
  beneficiary_phone: string
  bundle_display: string
  amount: number
  status: string
  payment_status: string
  created_at: string
  special_group_id?: string | null
  special_index?: number | null
}

export type OrderLine<O extends BundleOrderRow = BundleOrderRow> =
  | { kind: "single"; order: O }
  | {
      kind: "special"
      groupId: string
      title: string
      amount: number
      count: number
      status: { label: string; tone: string }
      reference_code: string
      network: string
      beneficiary_phone: string
      created_at: string
    }

/**
 * My orders: Special children (same special_group_id) become one line, placed where the group's first row
 * appears; every other order passes through untouched and in order.
 */
export function groupBundleOrders<O extends BundleOrderRow>(orders: O[]): OrderLine<O>[] {
  const groups = new Map<string, O[]>()
  for (const o of orders) {
    const g = o.special_group_id
    if (!g) continue
    const list = groups.get(g)
    if (list) list.push(o)
    else groups.set(g, [o])
  }
  const out: OrderLine<O>[] = []
  const emitted = new Set<string>()
  for (const o of orders) {
    const g = o.special_group_id
    if (!g) { out.push({ kind: "single", order: o }); continue }
    if (emitted.has(g)) continue
    emitted.add(g)
    const kids = [...(groups.get(g) ?? [])].sort((a, b) => (a.special_index ?? 0) - (b.special_index ?? 0))
    const first = kids[0]
    const count = kids.length
    const mb = parseBundleMb(first.bundle_display, "")
    const breakdown = `${count} × ${first.bundle_display}`
    out.push({
      kind: "special",
      groupId: g,
      title: mb === null ? `Special ${breakdown}` : `Special ${formatSpecialGb(mb * count)} (${breakdown})`,
      amount: kids.reduce((acc, k) => acc + cents(Number(k.amount)), 0) / 100,
      count,
      status: specialGroupStatus(kids.map(k => k.status)),
      reference_code: first.reference_code,
      network: first.network,
      beneficiary_phone: first.beneficiary_phone,
      created_at: first.created_at,
    })
  }
  return out
}
