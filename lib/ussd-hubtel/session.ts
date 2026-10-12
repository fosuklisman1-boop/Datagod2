import { Redis } from "@upstash/redis"
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
