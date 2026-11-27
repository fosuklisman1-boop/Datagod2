// Server helper shared by the token route and the waiting-line check-in route: open calls per Nuance account.
import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Open calls (no end yet, created after `openCutoff`) counted per Nuance account, across all identities.
 * Rows that were never given an account are not counted. Returns null when the read fails: callers treat that as
 * unavailable, since this path spends paid credits.
 */
export async function readOpenByKey(db: SupabaseClient, openCutoff: string): Promise<Record<number, number> | null> {
  const { data, error } = await db.from("ai_voice_calls").select("nuance_key").is("ended_at", null).gt("created_at", openCutoff)
  if (error) return null
  const openByKey: Record<number, number> = {}
  for (const r of (data ?? []) as { nuance_key?: number | null }[]) {
    if (typeof r.nuance_key === "number") openByKey[r.nuance_key] = (openByKey[r.nuance_key] ?? 0) + 1
  }
  return openByKey
}
