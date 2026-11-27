// 30-day retention for AI chat transcripts. Messages go with their conversation (ON DELETE CASCADE).
import type { SupabaseClient } from "@supabase/supabase-js"

export const RETENTION_DAYS = 30
const CHUNK = 500
const MAX_ROUNDS = 200 // 100k conversations per run is far more than a day produces; bounds the loop

/** Deletes conversations whose last activity is older than the retention window; returns how many were deleted. */
export async function deleteOldConversations(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  let deleted = 0
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { data, error } = await db.from("ai_conversations").select("id").lt("last_at", cutoff).limit(CHUNK)
    if (error) throw new Error("retention select failed")
    const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
    if (ids.length === 0) break
    const { error: dErr } = await db.from("ai_conversations").delete().in("id", ids)
    if (dErr) throw new Error("retention delete failed")
    deleted += ids.length
    if (ids.length < CHUNK) break
  }
  return deleted
}

/** Deletes waiting-line tickets (ai_voice_queue) created more than a day ago; returns how many were deleted. */
export async function deleteOldVoiceQueue(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const { count, error } = await db.from("ai_voice_queue").delete({ count: "exact" }).lt("created_at", cutoff)
  if (error) throw new Error("retention voice queue delete failed")
  return count ?? 0
}

/** Deletes ai_voice_calls rows created before the retention window; returns how many were deleted. */
export async function deleteOldVoiceCalls(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { count, error } = await db.from("ai_voice_calls").delete({ count: "exact" }).lt("created_at", cutoff)
  if (error) throw new Error("retention voice delete failed")
  return count ?? 0
}
