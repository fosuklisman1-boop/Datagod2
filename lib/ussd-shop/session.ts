import { Redis } from "@upstash/redis"
import { USSDShopSession } from "./types"

const SESSION_TTL = 120 // seconds — matches Uzo's session timeout

let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  } else {
    console.warn("[USSD-SHOP-SESSION] Upstash env vars not set — sessions will not persist")
  }
} catch (e) {
  console.error("[USSD-SHOP-SESSION] Failed to initialise Redis:", e)
}

function sessionKey(sessionId: string): string {
  return `ussd-shop:session:${sessionId}`
}

const fallbackCache = new Map<string, { data: USSDShopSession, expires: number }>()

export async function getSession(sessionId: string): Promise<USSDShopSession | null> {
  if (redis) {
    try {
      const data = await redis.get<USSDShopSession>(sessionKey(sessionId))
      if (data) return data
    } catch (e) {
      console.error("[USSD-SHOP-SESSION] get error:", e)
    }
  }
  
  // Fallback to in-memory cache
  const cached = fallbackCache.get(sessionId)
  if (cached && cached.expires > Date.now()) {
    return cached.data
  }
  return null
}

export async function setSession(sessionId: string, session: USSDShopSession): Promise<void> {
  if (redis) {
    try {
      await redis.setex(sessionKey(sessionId), SESSION_TTL, JSON.stringify(session))
      return
    } catch (e) {
      console.error("[USSD-SHOP-SESSION] set error:", e)
    }
  }
  
  // Fallback to in-memory cache
  fallbackCache.set(sessionId, { data: session, expires: Date.now() + SESSION_TTL * 1000 })
}

export async function deleteSession(sessionId: string): Promise<void> {
  if (redis) {
    try {
      await redis.del(sessionKey(sessionId))
    } catch (e) {
      console.error("[USSD-SHOP-SESSION] delete error:", e)
    }
  }
  fallbackCache.delete(sessionId)
}
