// lib/ussd-hubtel/log-safe.ts
// Log-safe view of a Supabase/PostgREST (or any) error. Postgres puts the offending row into
// `details` ("Failing row contains (...)") and key values into "Key (col)=(val)"; for Hubtel orders
// that is AFA name + Ghana Card, check-request index/DOB/PIN/WhatsApp, phone numbers. Only the code
// and a trimmed message are kept; `details` and `hint` are never included.

export const SAFE_DB_ERROR_MAX = 200

const ROW_DETAIL_MARKERS = ["Failing row contains", "Key ("]

export function safeDbError(err: unknown): { code?: string; message: string } {
  const obj = err != null && typeof err === "object" ? (err as { code?: unknown; message?: unknown }) : null
  const rawMessage = obj ? obj.message : err
  let message = typeof rawMessage === "string" ? rawMessage : rawMessage == null ? "" : String(rawMessage)
  for (const marker of ROW_DETAIL_MARKERS) {
    const i = message.indexOf(marker)
    if (i >= 0) message = `${message.slice(0, i).trimEnd()} [row details redacted]`
  }
  message = message.trim()
  if (!message) message = "unknown error"
  if (message.length > SAFE_DB_ERROR_MAX) message = message.slice(0, SAFE_DB_ERROR_MAX) + "..."
  const code = obj && typeof obj.code === "string" ? obj.code : undefined
  return code ? { code, message } : { message }
}
