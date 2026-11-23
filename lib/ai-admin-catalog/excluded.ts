export interface ExcludedRoute {
  path: string
  method: string
  reason: string
}

// Routes the AI must never call. Keep every row justified.
export const EXCLUDED: ExcludedRoute[] = [
  { path: "/api/admin/ai-config", method: "GET", reason: "AI configuration endpoint, the assistant must not read or change its own settings" },
  { path: "/api/admin/airtime/download", method: "POST", reason: "file download (CSV/XLSX/binary) response, not JSON" },
  { path: "/api/admin/backfill/airtime-payments", method: "GET", reason: "one-off data backfill script, bulk writes outside normal flows" },
  { path: "/api/admin/backfill/airtime-payments", method: "POST", reason: "one-off data backfill script, bulk writes outside normal flows" },
  { path: "/api/admin/blocked-numbers/export", method: "GET", reason: "file download (CSV/XLSX/binary) response, not JSON" },
  { path: "/api/admin/debug-balance", method: "GET", reason: "debug endpoint, diagnostic dump not meant for assistant use" },
  { path: "/api/admin/debug-latest", method: "GET", reason: "debug endpoint, diagnostic dump not meant for assistant use" },
  { path: "/api/admin/debug-orders", method: "GET", reason: "debug endpoint, diagnostic dump not meant for assistant use" },
  { path: "/api/admin/debug-shops", method: "GET", reason: "debug endpoint, diagnostic dump not meant for assistant use" },
  { path: "/api/admin/fix-failed-orders", method: "GET", reason: "one-off data repair script, bulk writes outside normal flows" },
  { path: "/api/admin/fix-failed-orders", method: "POST", reason: "one-off data repair script, bulk writes outside normal flows" },
  { path: "/api/admin/fix-missing-profits", method: "GET", reason: "one-off data repair script, bulk writes outside normal flows" },
  { path: "/api/admin/fix-missing-profits", method: "POST", reason: "one-off data repair script, bulk writes outside normal flows" },
  { path: "/api/admin/fix-orphaned-blacklisted", method: "POST", reason: "one-off data repair script, bulk writes outside normal flows" },
  { path: "/api/admin/mtn-registration/batch/:id/download", method: "GET", reason: "file download (CSV/XLSX/binary) response, not JSON" },
  { path: "/api/admin/mtn-registration/export", method: "GET", reason: "file download (CSV/XLSX/binary) response, not JSON" },
  { path: "/api/admin/orders/download", method: "POST", reason: "file download (CSV/XLSX/binary) response, not JSON" },
  { path: "/api/admin/orders/phone-export", method: "GET", reason: "file download (CSV/XLSX/binary) response, not JSON" },
  { path: "/api/admin/phone-verify/session/:id/export", method: "GET", reason: "file download (CSV/XLSX/binary) response, not JSON" },
  { path: "/api/admin/phone-verify/upload", method: "POST", reason: "multipart file upload (formData), cannot be driven from JSON" },
  { path: "/api/admin/results-checker/upload", method: "POST", reason: "multipart file upload (formData), cannot be driven from JSON" },
  { path: "/api/admin/setup-rls", method: "POST", reason: "one-off RLS setup script, alters database security policy" },
]
