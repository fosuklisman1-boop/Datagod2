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

const memory = new Map<string, { data: HubtelSession; expires: number }>()
const key = (id: string) => `ussd-hubtel:session:${id}`

export interface HubtelSessionStore {
  get(id: string): Promise<HubtelSession | null>
  set(id: string, s: HubtelSession): Promise<void>
  del(id: string): Promise<void>
}

export const sessionStore: HubtelSessionStore = {
  async get(id) {
    if (redis) {
      try {
        return (await redis.get<HubtelSession>(key(id))) ?? null
      } catch (e) {
        console.error("[HUBTEL-SESSION] get error for", id, ":", e)
        return null // router restarts the menu; never fall back to per-instance memory
      }
    }
    const m = memory.get(id)
    return m && m.expires > Date.now() ? m.data : null
  },
  async set(id, s) {
    if (redis) {
      try {
        await redis.setex(key(id), SESSION_TTL, JSON.stringify(s))
      } catch (e) {
        console.error("[HUBTEL-SESSION] set error for", id, ":", e)
      }
      return
    }
    memory.set(id, { data: s, expires: Date.now() + SESSION_TTL * 1000 })
  },
  async del(id) {
    if (redis) {
      try { await redis.del(key(id)) } catch (e) { console.error("[HUBTEL-SESSION] del error for", id, ":", e) }
      return
    }
    memory.delete(id)
  },
}
