/** Thrown when the override lookup failed for a reason OTHER than the column not existing yet. */
export class ProviderOverrideLookupError extends Error {
  constructor(message: string) { super(message); this.name = "ProviderOverrideLookupError" }
}

function isMissingColumn(e: { code?: string; message?: string }): boolean {
  return e.code === "42703" || e.code === "PGRST204" || /column.*does not exist|could not find.*column/i.test(e.message ?? "")
}

/**
 * Read of sms_send_logs.provider_override (migration 20261020). A separate query,
 * never part of an existing SELECT: PostgREST errors on a missing column, and ordinary sends must
 * keep working before the migration is applied. A missing-column error => no overrides. Any OTHER
 * error is logged and thrown (ProviderOverrideLookupError): silently ignoring it would route a
 * retry through a provider the sender did not choose.
 */
import type { SupabaseClient } from "@supabase/supabase-js"

export type SmsProviderChoice = "moolre" | "hubtel"
const CHUNK = 200

export async function fetchProviderOverrides(
  db: Pick<SupabaseClient, "from">,
  logIds: (string | number)[],
): Promise<Map<string, SmsProviderChoice>> {
  const out = new Map<string, SmsProviderChoice>()
  const ids = [...new Set(logIds)]
  for (let i = 0; i < ids.length; i += CHUNK) {
    try {
      const { data, error } = await db
        .from("sms_send_logs")
        .select("id, provider_override")
        .in("id", ids.slice(i, i + CHUNK))
      if (error) {
        if (isMissingColumn(error)) return out
        throw new ProviderOverrideLookupError(error.message)
      }
      for (const r of (data ?? []) as { id: string | number; provider_override: string | null }[]) {
        if (r.provider_override === "moolre" || r.provider_override === "hubtel") out.set(String(r.id), r.provider_override)
      }
    } catch (e) {
      if (e instanceof ProviderOverrideLookupError) {
        console.error("[SMS-PROVIDER] override lookup failed:", e.message)
        throw e
      }
      const err = e as { code?: string; message?: string }
      if (isMissingColumn(err)) return out
      console.error("[SMS-PROVIDER] override lookup threw:", err.message ?? e)
      throw new ProviderOverrideLookupError(String(err.message ?? e))
    }
  }
  return out
}
