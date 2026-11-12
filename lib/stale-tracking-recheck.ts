// Classifies a provider status reply for a stale tracking row (open for more than 7 days), used by
// POST /api/admin/stale-tracking/recheck. Only an explicit, successful "completed" or "failed" reply counts
// as the provider's answer; anything else (in flight, pending, an error, no status) stays for the owner.

/** Masks phone-number-like runs (9-15 digits, optional +) to their last 4 digits, so reports carry no PII. */
export function redactPhoneNumbers(message: string | null): string | null {
  if (message == null) return message
  return message.replace(/\+?\b\d{9,15}\b/g, (m) => `***${m.slice(-4)}`)
}

export type RecheckVerdict = "confirm_completed" | "confirm_failed" | "unresolved"

export function classifyRecheck(result: { success: boolean; status?: string; message?: string }): RecheckVerdict {
  if (result.success !== true) return "unresolved"
  if (result.status === "completed") return "confirm_completed"
  if (result.status === "failed") return "confirm_failed"
  return "unresolved"
}
