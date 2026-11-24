export interface ExcludedRoute {
  path: string
  method: string
  reason: string
}

// Routes the AI must never call. Keep every row justified.
export const EXCLUDED: ExcludedRoute[] = [
  { path: "/api/admin/afa-fulfillment", method: "POST", reason: "long-running (up to 300 s; fulfill-pending sends every unfulfilled AFA order to the supplier in a loop); use the page" },
  { path: "/api/admin/afa-registrations", method: "GET", reason: "fans out one auth lookup per row (up to 10000); use the page" },
  { path: "/api/admin/ai-config", method: "GET", reason: "AI configuration endpoint, the assistant must not read or change its own settings" },
  { path: "/api/admin/airtime/download", method: "POST", reason: "file download (CSV/XLSX/binary) response, not JSON" },
  { path: "/api/admin/backfill/airtime-payments", method: "GET", reason: "one-off data backfill script, bulk writes outside normal flows" },
  { path: "/api/admin/backfill/airtime-payments", method: "POST", reason: "one-off data backfill script, bulk writes outside normal flows" },
  { path: "/api/admin/blocked-numbers/check-all", method: "POST", reason: "long-running (up to 300 s, asks every supplier about up to 100 numbers); use the page" },
  { path: "/api/admin/blocked-numbers/export", method: "GET", reason: "file download (CSV/XLSX/binary) response, not JSON" },
  { path: "/api/admin/blocked-numbers/recheck", method: "POST", reason: "long-running (up to 300 s, re-checks up to 500 numbers or every due number with the suppliers); use the page" },
  { path: "/api/admin/customers/:id/history", method: "GET", reason: "not an admin route: a shop-owner route that only reads the signed-in user's own shop (own shop customer history), so it returns nothing useful for an admin" },
  { path: "/api/admin/customers/analytics", method: "GET", reason: "not an admin route: a shop-owner route that only reads the signed-in user's own shop (own shop customer stats), so it returns nothing useful for an admin" },
  { path: "/api/admin/customers/list", method: "GET", reason: "not an admin route: a shop-owner route that only reads the signed-in user's own shop (own shop customer list), so it returns nothing useful for an admin" },
  { path: "/api/admin/debug-balance", method: "GET", reason: "debug endpoint, diagnostic dump not meant for assistant use" },
  { path: "/api/admin/debug-latest", method: "GET", reason: "debug endpoint, diagnostic dump not meant for assistant use" },
  { path: "/api/admin/debug-orders", method: "GET", reason: "debug endpoint, diagnostic dump not meant for assistant use" },
  { path: "/api/admin/debug-shops", method: "GET", reason: "debug endpoint, diagnostic dump not meant for assistant use" },
  { path: "/api/admin/fix-failed-orders", method: "GET", reason: "one-off data repair script, bulk writes outside normal flows" },
  { path: "/api/admin/fix-failed-orders", method: "POST", reason: "one-off data repair script, bulk writes outside normal flows" },
  { path: "/api/admin/fix-missing-profits", method: "GET", reason: "one-off data repair script, bulk writes outside normal flows" },
  { path: "/api/admin/fix-missing-profits", method: "POST", reason: "one-off data repair script, bulk writes outside normal flows" },
  { path: "/api/admin/fix-orphaned-blacklisted", method: "POST", reason: "one-off data repair script, bulk writes outside normal flows" },
  { path: "/api/admin/fulfillment/bulk-manual-fulfill", method: "POST", reason: "long-running (up to 1000 orders, one supplier send each in sequence); use the page, or queue orders with fulfillment/enqueue" },
  { path: "/api/admin/initialize-balance", method: "GET", reason: "a GET that rewrites every shop's available balance from at most the first 1000 profit rows (the database's row cap), so on a bigger table it would save wrong balances; one-off setup script, use the page or ops" },
  { path: "/api/admin/mtn-registration/batch/:id/download", method: "GET", reason: "file download (CSV/XLSX/binary) response, not JSON" },
  { path: "/api/admin/mtn-registration/export", method: "GET", reason: "file download (CSV/XLSX/binary) response, not JSON" },
  { path: "/api/admin/mtn-whitelist/batch-verify", method: "POST", reason: "long-running (up to 300 s, checks up to 1000 registry numbers per call with every supplier); use the page" },
  { path: "/api/admin/orders/download", method: "POST", reason: "file download (CSV/XLSX/binary) response, not JSON" },
  { path: "/api/admin/orders/phone-export", method: "GET", reason: "file download (CSV/XLSX/binary) response, not JSON" },
  { path: "/api/admin/orders/recover-xpress-reversals", method: "POST", reason: "long-running (up to 300 s, one supplier call per order); use the page" },
  { path: "/api/admin/phone-verify/session/:id/export", method: "GET", reason: "file download (CSV/XLSX/binary) response, not JSON" },
  { path: "/api/admin/phone-verify/sessions", method: "GET", reason: "returns a bare JSON array, which the lookup filter cannot select fields from; use the page" },
  { path: "/api/admin/phone-verify/upload", method: "POST", reason: "multipart file upload (formData), cannot be driven from JSON" },
  { path: "/api/admin/results-checker/upload", method: "POST", reason: "multipart file upload (formData), cannot be driven from JSON" },
  { path: "/api/admin/setup-rls", method: "POST", reason: "one-off RLS setup script, alters database security policy" },
  { path: "/api/admin/set-admin-by-email", method: "POST", reason: "use users.set_admin by id (shows the account, writes an audit row); a masked email on a card cannot show which account gets full admin rights" },
  { path: "/api/admin/stale-tracking/recheck", method: "POST", reason: "long-running (up to 300 s, paced supplier calls); use the page" },
  { path: "/api/admin/users/bulk", method: "POST", reason: "long-running (up to 300 s: role or suspension changes for up to 200 users, or a message to up to 5000); use the page. Single users: users/update-role and users/suspend, or roles/members/move" },
  { path: "/api/admin/users/export", method: "GET", reason: "returns up to 5000 users' contact details in one reply, the same data as users list but unpaged for the model; use the page, or the users list lookup" },
]
