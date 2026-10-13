/**
 * sms_logs.sender_id (migrations/20261024_sms_logs_sender_id.sql) records the "From" used for a
 * platform Hubtel send. The app may deploy before that migration is applied, so the logging insert
 * retries once without the column when the database says it does not exist.
 */
export function isMissingSenderIdColumn(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false
  if (error.code === "PGRST204" || error.code === "42703") return true
  return /sender_id/.test(error.message ?? "") && /column/i.test(error.message ?? "")
}
