/**
 * Public data-bundle price tables for the network product pages (/mtn-data,
 * /telecel-data, /at-data), the homepage "Popular Data Packages" tiles and the
 * Service JSON-LD OfferCatalog. Pure, no I/O.
 *
 * Rows come from the same `packages` read as lib/seo/live-facts.ts (and are
 * cached with it). The price is always `packages.price`, the standard price a
 * normal account pays from its wallet (app/api/orders/purchase charges exactly
 * this). `dealer_price` is never read here, so a dealer price can't leak.
 *
 * Nothing is invented: a row has a validity only when its description says so,
 * and a type only when the network string names an AT sub-product.
 */

export type DataNet = "MTN" | "Telecel" | "AT"

export const DATA_NETS: readonly DataNet[] = ["MTN", "Telecel", "AT"]

/** Raw `packages` row as read by live-facts. size / description are optional for older callers. */
export interface RawPackageRow {
  network: string
  price: number | string | null
  is_available: boolean | null
  size?: string | null
  description?: string | null
}

export interface PriceRow {
  network: DataNet
  /** Display size, e.g. "1GB", "500MB". */
  size: string
  /** GH₵, finite and > 0. */
  price: number
  /** AT sub-product ("iShare" / "BigTime"), else null. */
  type: string | null
  /** Validity read from the description ("No expiry", "30 days"), else null. */
  validity: string | null
}

export type DataPriceTables = Record<DataNet, PriceRow[]>

/**
 * packages.network values seen in code: "MTN", "Telecel", "AirtelTigo",
 * "AT-iShare" / "AT - iShare" / "AT - ISHARE", "AT-BigTime" / "AT - BigTime".
 * Every AT sub-product counts for at-data.
 */
export function networkOf(network: string): DataNet | null {
  const n = String(network ?? "").trim().toLowerCase()
  if (!n) return null
  if (n.startsWith("mtn")) return "MTN"
  if (n.startsWith("telecel")) return "Telecel"
  if (n.startsWith("at") || n.startsWith("airteltigo") || n.startsWith("ishare")) return "AT"
  return null
}

/** AT sub-product named in the network string, in display order. */
const AT_TYPES: ReadonlyArray<[RegExp, string]> = [
  [/i-?share/i, "iShare"],
  [/big\s*-?time/i, "BigTime"],
]

export function typeOf(network: string): string | null {
  if (networkOf(network) !== "AT") return null
  for (const [re, label] of AT_TYPES) if (re.test(network)) return label
  return null
}

/** "1" / "1GB" / "1 gb" -> "1GB"; "500MB" -> "500MB"; anything else is shown trimmed. */
export function formatSize(size: unknown): string {
  const s = String(size ?? "").trim()
  const m = /^(\d+(?:\.\d+)?)\s*(gb|mb|tb)?$/i.exec(s)
  if (!m) return s
  return `${Number(m[1])}${(m[2] ?? "GB").toUpperCase()}`
}

/** Size in MB for sorting; unparseable sizes sort last. */
export function sizeInMb(size: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(gb|mb|tb)?\b/i.exec(size.trim())
  if (!m) return Number.POSITIVE_INFINITY
  const n = Number(m[1])
  const unit = (m[2] ?? "GB").toUpperCase()
  return unit === "MB" ? n : unit === "TB" ? n * 1024 * 1024 : n * 1024
}

/**
 * Validity, only when the admin-written description states one. Returns null
 * otherwise; we never guess.
 */
export function validityOf(description: unknown): string | null {
  const d = String(description ?? "")
  if (/\bno[n]?[\s-]*expir/i.test(d)) return "No expiry"
  const days = /\b(\d{1,3})\s*-?\s*days?\b/i.exec(d)
  if (days) {
    const n = Number(days[1])
    if (n > 0) return n === 1 ? "1 day" : `${n} days`
  }
  const hours = /\b(\d{1,3})\s*-?\s*(hours?|hrs?)\b/i.exec(d)
  if (hours) {
    const n = Number(hours[1])
    if (n > 0) return n === 1 ? "1 hour" : `${n} hours`
  }
  return null
}

function positive(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === "string" && v.trim() === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

const typeRank = (t: string | null): number => {
  if (t === null) return 0
  const i = AT_TYPES.findIndex(([, label]) => label === t)
  return i === -1 ? AT_TYPES.length + 1 : i + 1
}

/**
 * Available rows with a positive price and a size, grouped by network, sorted
 * by type, then size, then price. Exact duplicates are dropped.
 */
export function buildPriceTables(rows: readonly RawPackageRow[]): DataPriceTables {
  const out: DataPriceTables = { MTN: [], Telecel: [], AT: [] }
  const seen = new Set<string>()
  for (const row of rows) {
    if (row?.is_available !== true) continue
    const network = networkOf(row.network)
    const price = positive(row.price)
    const size = formatSize(row.size)
    if (!network || price === null || !size) continue
    const r: PriceRow = { network, size, price, type: typeOf(row.network), validity: validityOf(row.description) }
    const id = `${r.network}|${r.type}|${r.size}|${r.price}|${r.validity}`
    if (seen.has(id)) continue
    seen.add(id)
    out[network].push(r)
  }
  for (const net of DATA_NETS) {
    out[net].sort(
      (a, b) => typeRank(a.type) - typeRank(b.type) || sizeInMb(a.size) - sizeInMb(b.size) || a.price - b.price,
    )
  }
  return out
}

/** "MTN 1GB", "AT iShare 2GB", "Telecel 5GB (No expiry)". Used by the table caption and the OfferCatalog. */
export function rowLabel(r: PriceRow): string {
  const base = [r.network, r.type, r.size].filter(Boolean).join(" ")
  return r.validity ? `${base} (${r.validity})` : base
}

/** Which optional columns the table needs (only shown when at least one row has a value). */
export function tableColumns(rows: readonly PriceRow[]): { type: boolean; validity: boolean } {
  return { type: rows.some((r) => r.type !== null), validity: rows.some((r) => r.validity !== null) }
}

/** Distinct AT sub-products / validities present, for copy that only applies when they're on sale. */
export function hasType(rows: readonly PriceRow[], type: string): boolean {
  return rows.some((r) => r.type === type)
}

export function hasValidity(rows: readonly PriceRow[], validity: string): boolean {
  return rows.some((r) => r.validity === validity)
}

/** The cheapest row for each network (and AT sub-product), in network order. For the homepage tiles. */
export function cheapestRows(tables: DataPriceTables): PriceRow[] {
  const out: PriceRow[] = []
  for (const net of DATA_NETS) {
    const byType = new Map<string | null, PriceRow>()
    for (const r of tables[net]) {
      const cur = byType.get(r.type)
      if (!cur || r.price < cur.price) byType.set(r.type, r)
    }
    out.push(...[...byType.values()].sort((a, b) => typeRank(a.type) - typeRank(b.type)))
  }
  return out
}
