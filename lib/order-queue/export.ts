import type { QueueRow } from "./types"

export const EXPORT_COLUMNS = [
  "Order ID", "Type", "Network", "Size", "Price", "Status", "Phone", "Reference",
  "Last supplier", "Last error", "Attempts", "Created at",
] as const

export type ExportColumn = (typeof EXPORT_COLUMNS)[number]
export type SheetRow = Record<ExportColumn, string | number>

/** Rows for a one-sheet xlsx export of already-loaded queue rows (client-side; no order state changes). */
export function queueRowsToSheetRows(rows: QueueRow[]): SheetRow[] {
  return rows.map((r) => ({
    "Order ID": r.id,
    Type: r.type ?? "",
    Network: r.network ?? "",
    Size: r.volumeGb == null || r.volumeGb === "" ? "" : `${r.volumeGb}GB`,
    Price: r.price ?? "",
    Status: r.status ?? "",
    Phone: r.phoneNumber ?? "",
    Reference: r.paymentReference ?? "",
    "Last supplier": r.lastProvider ?? "",
    "Last error": r.lastError ?? "",
    Attempts: r.attemptCount,
    "Created at": r.createdAt,
  }))
}

/** Compact relative age ("<1m", "45m", "3h", "2d") of an ISO timestamp. */
export function formatAge(createdAt: string, now: number = Date.now()): string {
  const t = new Date(createdAt).getTime()
  if (!Number.isFinite(t)) return "—"
  const mins = Math.floor((now - t) / 60_000)
  if (mins < 1) return "<1m"
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
