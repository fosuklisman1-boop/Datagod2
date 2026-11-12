import type { SupabaseClient } from "@supabase/supabase-js"

/** An admin counts as "support active" if seen within this window. */
export const SUPPORT_ACTIVE_WINDOW_MS = 180_000

/** Record that an admin is looking at support. Never throws. */
export async function touchAdminPresence(db: SupabaseClient, adminId: string): Promise<void> {
  try {
    const { error } = await db
      .from("admin_presence")
      .upsert({ admin_id: adminId, last_seen_at: new Date().toISOString() }, { onConflict: "admin_id" })
    if (error) console.warn("[SUPPORT] presence upsert failed", { adminId })
  } catch {
    console.warn("[SUPPORT] presence upsert threw", { adminId })
  }
}

/** True when at least one admin was seen inside the window. False on any error. */
export async function isSupportActive(db: SupabaseClient, now: Date = new Date()): Promise<boolean> {
  try {
    const since = new Date(now.getTime() - SUPPORT_ACTIVE_WINDOW_MS).toISOString()
    const { data, error } = await db.from("admin_presence").select("admin_id").gte("last_seen_at", since).limit(1)
    if (error) return false
    return Array.isArray(data) && data.length > 0
  } catch {
    return false
  }
}
