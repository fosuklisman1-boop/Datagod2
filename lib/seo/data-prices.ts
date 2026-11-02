/**
 * Adjusted customer prices for the public data pages. Pure: the adjustment
 * helpers are reused from lib/price-adjustment-service.ts so the public price
 * matches what customers see on /dashboard/data-packages.
 */
import {
  getAdjustmentForNetwork,
  applyPriceAdjustment,
  type PriceAdjustments,
} from "@/lib/price-adjustment-service"

/**
 * packages.network values seen in code: "MTN", "Telecel", "AirtelTigo",
 * "AT-iShare" / "AT - iShare" / "AT - ISHARE", "AT-BigTime" / "AT - BigTime".
 * Every AT sub-product counts for at-data. (Lives here, re-exported by
 * live-facts, to keep the import graph acyclic.)
 */
export function networkOf(network: string): "MTN" | "Telecel" | "AT" | null {
  const n = String(network ?? "").trim().toLowerCase()
  if (!n) return null
  if (n.startsWith("mtn")) return "MTN"
  if (n.startsWith("telecel")) return "Telecel"
  if (n.startsWith("at") || n.startsWith("airteltigo") || n.startsWith("ishare")) return "AT"
  return null
}

/**
 * The exact packages.network values the customer dashboard shows
 * (app/dashboard/data-packages/page.tsx NETWORK_META). Public price rows are
 * restricted to these, so a public page never lists what the dashboard hides.
 */
export const DASHBOARD_NETWORKS = ["MTN", "Telecel", "AT - iShare", "AT - BigTime"] as const

export type PriceRow = {
  /** the stored packages.size, trimmed */
  size: string
  /** display label: bare "1" -> "1GB", "500MB" stays, unparseable -> the stored string */
  label: string
  price: number
  gb: number | null
  perGb: number | null
}
export type PriceGroup = { network: string; rows: PriceRow[] }
export type PriceGroups = Record<"MTN" | "Telecel" | "AT", PriceGroup[]>

const SIZE_RE = /^\s*(\d+(?:\.\d+)?)\s*(gb|mb)?\s*$/i

/** Parses a stored size. No unit means GB (the platform stores "1", "2", ...). */
function parseSize(size: string | null | undefined): { gb: number; label: string } | null {
  const m = SIZE_RE.exec(String(size ?? ""))
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const mb = m[2]?.toLowerCase() === "mb"
  return { gb: mb ? n / 1000 : n, label: `${n}${mb ? "MB" : "GB"}` }
}

/** "1"->1, "1GB"->1, "1.5 gb"->1.5, "500MB"->0.5 (1000 MB = 1 GB); anything else null. */
export function parseSizeGb(size: string | null | undefined): number | null {
  return parseSize(size)?.gb ?? null
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function buildPriceGroups(
  rows: Array<{ network: string; size?: string | null; price: number | string | null; is_available: boolean | null }>,
  adjustments: PriceAdjustments,
): PriceGroups {
  // network value -> normalised size -> cheapest adjusted price (with the stored size)
  const byNetwork: Record<"MTN" | "Telecel" | "AT", Map<string, Map<string, { size: string; price: number }>>> = {
    MTN: new Map(),
    Telecel: new Map(),
    AT: new Map(),
  }

  for (const row of rows) {
    if (row?.is_available !== true) continue
    if (!(DASHBOARD_NETWORKS as readonly string[]).includes(row.network)) continue
    const net = networkOf(row.network)
    if (!net) continue
    const size = String(row.size ?? "").trim()
    if (!size) continue
    if (row.price === null || row.price === undefined || (typeof row.price === "string" && row.price.trim() === "")) continue
    const base = typeof row.price === "number" ? row.price : Number(row.price)
    if (!Number.isFinite(base)) continue
    const price = applyPriceAdjustment(base, getAdjustmentForNetwork(row.network, adjustments))
    if (!Number.isFinite(price) || price <= 0) continue

    const sizes = byNetwork[net].get(row.network) ?? new Map<string, { size: string; price: number }>()
    byNetwork[net].set(row.network, sizes)
    const parsed = parseSize(size)
    const key = parsed ? `gb:${parsed.gb}` : `s:${size.toLowerCase()}`
    const prev = sizes.get(key)
    if (prev === undefined || price < prev.price) sizes.set(key, { size, price })
  }

  const out: PriceGroups = { MTN: [], Telecel: [], AT: [] }
  for (const net of ["MTN", "Telecel", "AT"] as const) {
    out[net] = [...byNetwork[net].entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([network, sizes]) => ({
        network,
        rows: [...sizes.values()]
          .map(({ size, price }): PriceRow => {
            const parsed = parseSize(size)
            const gb = parsed?.gb ?? null
            return { size, label: parsed?.label ?? size, price, gb, perGb: gb !== null ? round2(price / gb) : null }
          })
          .sort((a, b) => {
            if (a.gb === null && b.gb === null) return a.price - b.price
            if (a.gb === null) return 1
            if (b.gb === null) return -1
            return a.gb - b.gb || a.price - b.price
          }),
      }))
  }
  return out
}
