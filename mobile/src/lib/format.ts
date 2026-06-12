// Shared formatting helpers — ONE way to render money and dates app-wide.

export function formatGHS(amount: number | string | null | undefined): string {
  const n = Number(amount)
  return `GHS ${(Number.isFinite(n) ? Math.max(0, n) : 0).toFixed(2)}`
}

// Signed variant for transaction rows: +GHS 5.00 / -GHS 5.00.
export function formatGHSSigned(amount: number | string, credit: boolean): string {
  const n = Math.abs(Number(amount) || 0)
  return `${credit ? "+" : "-"}GHS ${n.toFixed(2)}`
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString()
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString()
}
