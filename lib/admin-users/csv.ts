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
