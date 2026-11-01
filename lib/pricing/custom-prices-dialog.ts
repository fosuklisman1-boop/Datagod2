// Pure helpers for components/admin/CustomPricesDialog.tsx (kept separate so they can be unit-tested).

export interface CustomPriceRow {
  id: string
  network: string
  size: string | number
  price: number
  dealer_price: number | null
  role_price: number
  custom_price: number | null
  is_available?: boolean
}

export interface PriceChange {
  package_id: string
  price: number | null
}

const NUMERIC = /^(\d+\.?\d*|\.\d+)$/

/** Parse an admin-typed price. "" means "no custom price"; anything else must be a plain decimal number. */
export function parsePriceInput(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const s = (raw ?? "").trim()
  if (s === "") return { ok: true, value: null }
  if (!NUMERIC.test(s)) return { ok: false, error: "Enter a number, e.g. 6.50" }
  const v = Number(s)
  if (!Number.isFinite(v)) return { ok: false, error: "Enter a number, e.g. 6.50" }
  if (v <= 0) return { ok: false, error: "Price must be more than 0" }
  if (v > 10000) return { ok: false, error: "Price must be at most 10,000" }
  if (Math.round(v * 100) / 100 !== v) return { ok: false, error: "At most 2 decimal places" }
  return { ok: true, value: v }
}

/**
 * Rows whose input differs from the saved custom price: a number to set, null to remove.
 * "6" and "6.00" both equal a saved 6. Unparseable inputs are reported in `invalid` (keyed by package id)
 * and are never included in `changes`.
 */
export function computeChanges(rows: CustomPriceRow[], inputs: Record<string, string>) {
  const changes: PriceChange[] = []
  const invalid: Record<string, string> = {}
  for (const r of rows) {
    const parsed = parsePriceInput(inputs[r.id] ?? "")
    if (!parsed.ok) {
      invalid[r.id] = parsed.error
      continue
    }
    if (parsed.value === r.custom_price) continue
    if (parsed.value !== null && r.custom_price !== null && Math.round(parsed.value * 100) === Math.round(r.custom_price * 100)) continue
    changes.push({ package_id: r.id, price: parsed.value })
  }
  return { changes, invalid }
}

/** Non-blocking hint for a row, or null. */
export function warningFor(r: CustomPriceRow, raw: string): string | null {
  const parsed = parsePriceInput(raw)
  if (!parsed.ok || parsed.value === null) return null
  const v = parsed.value
  if (r.dealer_price != null && r.dealer_price > 0 && v < r.dealer_price) return "Below the dealer price: may be below cost"
  if (v > r.role_price) return "Above this user's role price: they pay more than normal"
  return null
}

export type BulkMode = "per_gb" | "percent"
/** What a percentage adjusts: the user's role price, the dealer price, or their current custom price. */
export type BulkBase = "role" | "dealer" | "custom"

export interface BulkPreviewRow {
  row: CustomPriceRow
  /** The price currently in the input (null = blank / not a number). */
  current: number | null
  /** The price Apply would fill, or null when this row can't be filled (see reason). */
  newPrice: number | null
  reason?: string
  warn: string | null
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Bulk tab of the custom prices dialog. per_gb: price = size (GB) x rate. percent: a signed
 * adjustment of the chosen base (-10 = 10% off, +5 = 5% more). null while the value isn't usable.
 * Nothing here saves: Apply only fills the inputs, and the normal Save validates the batch.
 */
export function bulkPreview(
  rows: CustomPriceRow[],
  inputs: Record<string, string>,
  opts: { mode: BulkMode; value: string; base: BulkBase; network: string | "all" },
): BulkPreviewRow[] | null {
  const raw = (opts.value ?? "").trim()
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) return null
  const v = Number(raw)
  if (!Number.isFinite(v)) return null
  if (opts.mode === "per_gb" && v <= 0) return null
  if (opts.mode === "percent" && (v <= -100 || v === 0)) return null

  return rows
    .filter((r) => opts.network === "all" || r.network === opts.network)
    .map((r) => {
      const parsedCurrent = parsePriceInput(inputs[r.id] ?? "")
      const current = parsedCurrent.ok ? parsedCurrent.value : null
      let next: number
      if (opts.mode === "per_gb") {
        next = (parseFloat(String(r.size)) || 0) * v
      } else {
        const base =
          opts.base === "role" ? r.role_price
          : opts.base === "dealer" ? (r.dealer_price != null && r.dealer_price > 0 ? r.dealer_price : null)
          : current
        if (base == null) {
          return { row: r, current, newPrice: null, reason: opts.base === "dealer" ? "No dealer price" : "No custom price", warn: null }
        }
        next = base * (1 + v / 100)
      }
      const newPrice = round2(next)
      const check = parsePriceInput(newPrice.toFixed(2))
      if (!check.ok || check.value === null) return { row: r, current, newPrice: null, reason: "Out of range", warn: null }
      return { row: r, current, newPrice, warn: warningFor(r, newPrice.toFixed(2)) }
    })
}
