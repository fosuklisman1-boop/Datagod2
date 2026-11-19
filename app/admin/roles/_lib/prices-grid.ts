import { bulkFromPublic, bulkFromRole } from "@/lib/roles/admin/bulk-prices"
import { validateReason } from "@/lib/roles/admin/validate"

/** One row of GET /api/admin/roles/[id]/prices. cost_price is null when no cost is set. */
export interface PriceRow {
  id: string
  network: string
  name: string
  price: number
  cost_price: number | null
  role_price: number | null
  effective_price: number
  is_available: boolean
}

/** package id -> text in the role-price input. A missing key means the cell was not touched. */
export type Edits = Record<string, string>

const round2 = (x: number) => Math.round(x * 100) / 100

export type Cell =
  | { kind: "same" }
  | { kind: "invalid" }
  | { kind: "set"; price: number }
  | { kind: "clear" }

/** What an input's text means against the loaded row. Dirty = numerically different from what was loaded. */
export function cellState(row: PriceRow, text: string | undefined): Cell {
  if (text === undefined) return { kind: "same" }
  const t = text.trim()
  if (t === "") return row.role_price == null ? { kind: "same" } : { kind: "clear" }
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return { kind: "invalid" }
  const price = round2(n)
  if (!Number.isFinite(price) || price <= 0) return { kind: "invalid" }
  return row.role_price != null && round2(row.role_price) === price ? { kind: "same" } : { kind: "set", price }
}

export function dirtyChanges(
  rows: readonly PriceRow[],
  edits: Edits,
): { changes: { package_id: string; price: number | null }[]; invalid: string[] } {
  const changes: { package_id: string; price: number | null }[] = []
  const invalid: string[] = []
  for (const r of rows) {
    const c = cellState(r, edits[r.id])
    if (c.kind === "set") changes.push({ package_id: r.id, price: c.price })
    else if (c.kind === "clear") changes.push({ package_id: r.id, price: null })
    else if (c.kind === "invalid") invalid.push(r.id)
  }
  return { changes, invalid }
}

/** Dirty rows whose rounded price is under a known cost. A null cost is never "below". */
export function belowCostIds(rows: readonly PriceRow[], edits: Edits): string[] {
  const out: string[] = []
  for (const r of rows) {
    const c = cellState(r, edits[r.id])
    if (c.kind === "set" && r.cost_price != null && c.price < r.cost_price) out.push(r.id)
  }
  return out
}

/** Margin of a price over the cost (amount in GHS, percent of the selling price); null when no cost is set. */
export function marginOf(row: PriceRow, price: number): { amount: number; percent: number } | null {
  if (row.cost_price == null) return null
  const amount = round2(price - row.cost_price)
  const percent = price > 0 ? round2((amount / price) * 100) : 0
  return { amount, percent }
}

export function canSavePrices(a: {
  rows: readonly PriceRow[]
  edits: Edits
  lossOk: boolean
  reason: string
}): { ok: boolean; why: string | null } {
  const { changes, invalid } = dirtyChanges(a.rows, a.edits)
  if (invalid.length > 0) return { ok: false, why: "Fix the invalid prices first" }
  if (changes.length === 0) return { ok: false, why: "No changes" }
  if (!validateReason(a.reason).ok) return { ok: false, why: "Add a reason (3+ characters)" }
  if (belowCostIds(a.rows, a.edits).length > 0 && !a.lossOk) return { ok: false, why: "Tick the loss box to sell below cost" }
  return { ok: true, why: null }
}

/** `serverFlagged` = the server already rejected this save as below cost (its cost view differs from ours). */
export function buildPricesPut(rows: readonly PriceRow[], edits: Edits, lossOk: boolean, reason: string, serverFlagged = false) {
  const { changes } = dirtyChanges(rows, edits)
  return { changes, loss_override: lossOk && (serverFlagged || belowCostIds(rows, edits).length > 0), reason: reason.trim() }
}

type Preview = { ok: true; edits: Edits; skipped: number } | { ok: false; error: string }

const parseNum = (text: string): number | null => {
  if (text.trim() === "") return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

const toEdits = (changes: { package_id: string; price: number }[]): Edits => {
  const e: Edits = {}
  for (const c of changes) e[c.package_id] = String(c.price)
  return e
}

/** public price minus x%. Validates first so the lib's RangeError never reaches React. */
export function bulkPublicPreview(rows: readonly PriceRow[], percentText: string): Preview {
  const pct = parseNum(percentText)
  if (pct === null || pct < 0 || pct > 100) return { ok: false, error: "Enter a percentage from 0 to 100" }
  try {
    const r = bulkFromPublic(rows.map((x) => ({ id: x.id, price: x.price })), pct)
    return { ok: true, edits: toEdits(r.changes), skipped: r.skipped.length }
  } catch {
    return { ok: false, error: "Enter a percentage from 0 to 100" }
  }
}

/** Source role's price per package: its role_price, else its effective_price. Counts say which was used. */
export function sourceMapFrom(rows: readonly PriceRow[]): { map: Map<string, number>; usedRolePrice: number; usedEffective: number } {
  const map = new Map<string, number>()
  let usedRolePrice = 0
  let usedEffective = 0
  for (const r of rows) {
    if (r.role_price != null) {
      map.set(r.id, r.role_price)
      usedRolePrice++
    } else if (Number.isFinite(r.effective_price)) {
      map.set(r.id, r.effective_price)
      usedEffective++
    }
  }
  return { map, usedRolePrice, usedEffective }
}

/** Source prices plus or minus a GHS delta, limited to packages in the visible grid. */
export function bulkRolePreview(source: ReadonlyMap<string, number>, rows: readonly PriceRow[], deltaText: string): Preview {
  const delta = parseNum(deltaText)
  if (delta === null) return { ok: false, error: "Enter an amount in GHS (for example -1 or 0.5)" }
  const visible = new Set(rows.map((r) => r.id))
  const scoped = new Map<string, number>()
  for (const [id, p] of source) if (visible.has(id)) scoped.set(id, p)
  try {
    const r = bulkFromRole(scoped, delta)
    return { ok: true, edits: toEdits(r.changes), skipped: r.skipped.length }
  } catch {
    return { ok: false, error: "Enter an amount in GHS (for example -1 or 0.5)" }
  }
}
