// lib/ussd-hubtel/session.ts
// Hubtel USSD session state lives in ONE place: the hubtel_ussd_sessions table (migration 0112),
// shared by every serverless instance. No Redis and no per-instance copy: a second store can serve
// an older step than the one the caller is on (a recipient number read as a shop code). A failed
// read is a miss; the router then restores the session from the signed ClientState snapshot
// (client-state.ts) or restarts with "Session expired".
import type { SupabaseClient } from "@supabase/supabase-js"
import { safeDbError } from "./log-safe"
import type { HubtelSession } from "./types"

export interface HubtelSessionStore {
  get(id: string): Promise<HubtelSession | null>
  set(id: string, s: HubtelSession): Promise<void>
  del(id: string): Promise<void>
}

const DB_TABLE = "hubtel_ussd_sessions"
/** A slow caller (looking up a shop code) must not lose the session. Timeout/finish delete it. */
export const DB_SESSION_TTL_SECONDS = 300
/** Expired rows are purged on roughly 1 in this many writes (abandoned sessions only; finished ones are deleted). */
const PURGE_EVERY = 50

export function dbSessionStore(supabase: SupabaseClient, now: () => number = Date.now): HubtelSessionStore {
  return {
    async get(id) {
      try {
        const { data, error } = await supabase.from(DB_TABLE).select("data, expires_at").eq("session_id", id).maybeSingle()
        if (error) throw error
        if (!data) return null
        const row = data as { data: HubtelSession; expires_at: string }
        return new Date(row.expires_at).getTime() > now() ? row.data : null
      } catch (e) {
        console.error("[HUBTEL-SESSION] get failed for", id, ":", safeDbError(e))
        return null
      }
    },
    async set(id, s) {
      try {
        const { error } = await supabase.from(DB_TABLE).upsert({
          session_id: id, data: s,
          expires_at: new Date(now() + DB_SESSION_TTL_SECONDS * 1000).toISOString(),
          updated_at: new Date(now()).toISOString(),
        })
        if (error) throw error
      } catch (e) {
        console.error("[HUBTEL-SESSION] set failed for", id, ":", safeDbError(e))
        return
      }
      if (Math.random() < 1 / PURGE_EVERY) {
        const { error } = await supabase.from(DB_TABLE).delete().lt("expires_at", new Date(now()).toISOString())
        if (error) console.warn("[HUBTEL-SESSION] purge of expired sessions failed:", safeDbError(error))
      }
    },
    async del(id) {
      try {
        const { error } = await supabase.from(DB_TABLE).delete().eq("session_id", id)
        if (error) console.error("[HUBTEL-SESSION] del failed for", id, ":", safeDbError(error))
      } catch (e) {
        console.error("[HUBTEL-SESSION] del threw for", id, ":", safeDbError(e))
      }
    },
  }
}
