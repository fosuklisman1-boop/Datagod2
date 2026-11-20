import { validateReason } from "@/lib/roles/admin/validate"

export interface RateRow {
  service_key: string
  label: string
  value: number | null
  effective: number
}

const round2 = (x: number) => Math.round(x * 100) / 100

type One = { kind: "same" } | { kind: "invalid" } | { kind: "set"; value: number } | { kind: "clear" }

function cell(row: RateRow, text: string | undefined): One {
  if (text === undefined) return { kind: "same" }
  const t = text.trim()
  if (t === "") return row.value == null ? { kind: "same" } : { kind: "clear" }
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0 || n > 100) return { kind: "invalid" }
  const value = round2(n)
  return row.value != null && round2(row.value) === value ? { kind: "same" } : { kind: "set", value }
}

export function rateChanges(
  rates: readonly RateRow[],
  edits: Record<string, string>,
): { ok: true; changes: { service_key: string; value: number | null }[] } | { ok: false; error: string } {
  const changes: { service_key: string; value: number | null }[] = []
  for (const r of rates) {
    const c = cell(r, edits[r.service_key])
    if (c.kind === "invalid") return { ok: false, error: `${r.label}: enter a number from 0 to 100, or leave blank` }
    if (c.kind === "set") changes.push({ service_key: r.service_key, value: c.value })
    else if (c.kind === "clear") changes.push({ service_key: r.service_key, value: null })
  }
  return { ok: true, changes }
}

/** Confirm text when any airtime fee is set above 10%; cashback shares get no extra guard. */
export function airtimeFeeWarning(changes: readonly { service_key: string; value: number | null }[]): string | null {
  const high = changes.some((c) => c.service_key.startsWith("airtime_fee:") && c.value != null && c.value > 10)
  return high ? "Airtime fee above 10% is unusual — save anyway?" : null
}

export const rateDirtyCount = (rates: readonly RateRow[], edits: Record<string, string>) =>
  rates.filter((r) => {
    const c = cell(r, edits[r.service_key])
    return c.kind === "set" || c.kind === "clear"
  }).length

export function canSaveRates(rates: readonly RateRow[], edits: Record<string, string>, reason: string): { ok: boolean; why: string | null } {
  const r = rateChanges(rates, edits)
  if (!r.ok) return { ok: false, why: r.error }
  if (r.changes.length === 0) return { ok: false, why: "No changes" }
  if (!validateReason(reason).ok) return { ok: false, why: "Add a reason (3+ characters)" }
  return { ok: true, why: null }
}
