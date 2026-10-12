/**
 * Best-effort read of sms_send_logs.provider_override (migration 20261020). A separate query,
 * never part of an existing SELECT: PostgREST errors on a missing column, and ordinary sends must
 * keep working before the migration is applied. Any error => no overrides (never throws).
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
      if (error) continue
      for (const r of (data ?? []) as { id: string | number; provider_override: string | null }[]) {
        if (r.provider_override === "moolre" || r.provider_override === "hubtel") out.set(String(r.id), r.provider_override)
      }
    } catch { /* column/table unavailable: no override */ }
  }
  return out
}
