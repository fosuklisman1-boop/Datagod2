// CSV bodies for the admin users downloads. Same columns and quoting as before
// the page was split; only the rows changed (every user matching the filters).

export interface CsvUser {
  email: string
  phoneNumber: string
  role: string
  walletBalance: number
  shopBalance: number
  shop: { shop_name: string } | null
  customerCount: number
  created_at: string
}

export function emailsCsv(users: Pick<CsvUser, "email">[]): string {
  return [["Email"], ...users.map((u) => [u.email])].map((row) => row.join(",")).join("\n")
}

export function phonesCsv(users: Pick<CsvUser, "phoneNumber">[]): string {
  return [["Phone Number"], ...users.map((u) => [u.phoneNumber || ""])].map((row) => row.join(",")).join("\n")
}

export function allDataCsv(users: CsvUser[], formatDate: (iso: string) => string = (iso) => new Date(iso).toLocaleDateString()): string {
  const headers = ["Email", "Phone Number", "Role", "Wallet Balance (GHS)", "Shop Balance (GHS)", "Shop Name", "Total Customers", "Joined Date"]
  const rows = users.map((u) => [
    u.email,
    u.phoneNumber || "",
    u.role,
    u.walletBalance.toFixed(2),
    u.shopBalance.toFixed(2),
    u.shop?.shop_name || "",
    u.customerCount || 0,
    formatDate(u.created_at),
  ])
  return [headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n")
}

/** File-name label for the current filters, e.g. "dealer" or "all". */
export function exportLabel(f: { role?: string | null; q?: string | null; suspended?: boolean | null; hasShop?: boolean | null; pricingMode?: string | null; from?: string | null; to?: string | null }): string {
  const base = f.role || "all"
  const narrowed = !!(f.q || f.suspended != null || f.hasShop != null || f.pricingMode || f.from || f.to)
  return narrowed ? `${base}_filtered` : base
}

export interface DownloadEnv {
  document: Pick<Document, "createElement" | "body">
  URL: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">
  /** When to revoke the object URL (after the click has been handled). */
  defer?: (fn: () => void) => void
}

/** Save `csv` as `filename` via a Blob object URL (no size limit like a data: URL), then revoke it. */
export function triggerCsvDownload(filename: string, csv: string, env?: DownloadEnv): void {
  const e: DownloadEnv = env ?? { document, URL }
  const href = e.URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
  const a = e.document.createElement("a")
  a.href = href
  a.download = filename
  a.style.display = "none"
  e.document.body.appendChild(a)
  try {
    a.click()
  } finally {
    e.document.body.removeChild(a)
    ;(e.defer ?? ((fn) => setTimeout(fn, 0)))(() => e.URL.revokeObjectURL(href))
  }
}
