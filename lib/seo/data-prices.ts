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

export type PriceRow = { size: string; price: number; gb: number | null; perGb: number | null }
export type PriceGroup = { network: string; rows: PriceRow[] }
export type PriceGroups = Record<"MTN" | "Telecel" | "AT", PriceGroup[]>

/** "1GB"→1, "1.5 gb"→1.5, "500MB"→0.5 (1000 MB = 1 GB); anything else null. */
export function parseSizeGb(size: string | null | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(gb|mb)\s*$/i.exec(String(size ?? ""))
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  return m[2].toLowerCase() === "gb" ? n : n / 1000
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function buildPriceGroups(
  rows: Array<{ network: string; size?: string | null; price: number | string | null; is_available: boolean | null }>,
  adjustments: PriceAdjustments,
): PriceGroups {
  // network value -> size -> cheapest adjusted price
  const byNetwork: Record<"MTN" | "Telecel" | "AT", Map<string, Map<string, number>>> = {
    MTN: new Map(),
    Telecel: new Map(),
    AT: new Map(),
  }

  for (const row of rows) {
    if (row?.is_available !== true) continue
    const net = networkOf(row.network)
    if (!net) continue
    const size = String(row.size ?? "").trim()
    if (!size) continue
    if (row.price === null || row.price === undefined || (typeof row.price === "string" && row.price.trim() === "")) continue
    const base = typeof row.price === "number" ? row.price : Number(row.price)
    if (!Number.isFinite(base)) continue
    const price = applyPriceAdjustment(base, getAdjustmentForNetwork(row.network, adjustments))
    if (!Number.isFinite(price) || price <= 0) continue

    const sizes = byNetwork[net].get(row.network) ?? new Map<string, number>()
    byNetwork[net].set(row.network, sizes)
    const prev = sizes.get(size)
    if (prev === undefined || price < prev) sizes.set(size, price)
  }

  const out: PriceGroups = { MTN: [], Telecel: [], AT: [] }
  for (const net of ["MTN", "Telecel", "AT"] as const) {
    out[net] = [...byNetwork[net].entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([network, sizes]) => ({
        network,
        rows: [...sizes.entries()]
          .map(([size, price]): PriceRow => {
            const gb = parseSizeGb(size)
            return { size, price, gb, perGb: gb !== null ? round2(price / gb) : null }
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
