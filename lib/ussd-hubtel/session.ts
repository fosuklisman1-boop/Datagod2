import { Redis } from "@upstash/redis"
import type { SupabaseClient } from "@supabase/supabase-js"
import { safeDbError } from "./log-safe"
import type { HubtelSession } from "./types"

const SESSION_TTL = 120 // seconds

let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  } else {
    console.warn("[HUBTEL-SESSION] Upstash env vars not set — using in-process sessions (dev only)")
  }
} catch (e) {
  console.error("[HUBTEL-SESSION] Failed to initialise Redis:", e)
}

// In-process copy, used only when Redis is absent or a Redis call FAILS (same fallback as the Uzo
// shop session). Not shared between serverless instances, so it only rescues a session whose
// requests land on the same warm instance; a Redis-written session never goes here, so a plain
// Redis miss (TTL, del) is never contradicted by a stale in-process copy.
const memory = new Map<string, { data: HubtelSession; expires: number }>()
const key = (id: string) => `ussd-hubtel:session:${id}`

function fromMemory(id: string): HubtelSession | null {
  const m = memory.get(id)
  if (m && m.expires > Date.now()) return m.data
  memory.delete(id)
  return null
}

export interface HubtelSessionStore {
  get(id: string): Promise<HubtelSession | null>
  set(id: string, s: HubtelSession): Promise<void>
  del(id: string): Promise<void>
}

export const sessionStore: HubtelSessionStore = {
  async get(id) {
    if (redis) {
      try {
        const data = await redis.get<HubtelSession>(key(id))
        if (data) return data
      } catch (e) {
        console.error("[HUBTEL-SESSION] get error for", id, ":", e)
      }
    }
    return fromMemory(id)
  },
  async set(id, s) {
    if (redis) {
      try {
        await redis.setex(key(id), SESSION_TTL, JSON.stringify(s))
        memory.delete(id) // Redis holds the current copy; drop any older fallback
        return
      } catch (e) {
        console.error("[HUBTEL-SESSION] set error for", id, ":", e)
      }
    }
    memory.set(id, { data: s, expires: Date.now() + SESSION_TTL * 1000 })
  },
  async del(id) {
    memory.delete(id)
    if (redis) {
      try { await redis.del(key(id)) } catch (e) { console.error("[HUBTEL-SESSION] del error for", id, ":", e) }
    }
  },
}

const DB_TABLE = "hubtel_ussd_sessions"
/** Longer than Redis's 120s: a slow caller (looking up a shop code) must not lose the session. Timeout/finish delete it. */
export const DB_SESSION_TTL_SECONDS = 300
/** Expired rows are purged on roughly 1 in this many writes (abandoned sessions only; finished ones are deleted). */
const PURGE_EVERY = 50

/**
 * Postgres-backed store (migration 0112), shared by every serverless instance. On a DB error it
 * falls back to `fallback` (Redis, then in-process), so the deploy is safe before the migration.
 * A DB miss is a miss: the fallback is consulted only when the DB call itself fails.
 */
export function dbSessionStore(
  supabase: SupabaseClient, fallback: HubtelSessionStore = sessionStore, now: () => number = Date.now
): HubtelSessionStore {
  return {
    async get(id) {
      try {
        const { data, error } = await supabase.from(DB_TABLE).select("data, expires_at").eq("session_id", id).maybeSingle()
        if (error) throw error
        if (!data) return null
        const row = data as { data: HubtelSession; expires_at: string }
        return new Date(row.expires_at).getTime() > now() ? row.data : null
      } catch (e) {
        console.error("[HUBTEL-SESSION] db get failed for", id, ":", safeDbError(e))
        return fallback.get(id)
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
        console.error("[HUBTEL-SESSION] db set failed for", id, ":", safeDbError(e))
        await fallback.set(id, s)
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
        if (error) console.error("[HUBTEL-SESSION] db del failed for", id, ":", safeDbError(error))
      } catch (e) {
        console.error("[HUBTEL-SESSION] db del threw for", id, ":", safeDbError(e))
      }
      await fallback.del(id) // also clears any copy written while the DB was failing
    },
  }
}
