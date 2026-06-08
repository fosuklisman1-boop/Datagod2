import { Redis } from "@upstash/redis"
import { USSDSession } from "./types"

const SESSION_TTL = 120 // seconds — matches Uzo's session timeout

let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  } else {
    console.warn("[USSD-SESSION] Upstash env vars not set — sessions will not persist")
  }
} catch (e) {
  console.error("[USSD-SESSION] Failed to initialise Redis:", e)
}

function sessionKey(sessionId: string): string {
  return `ussd:session:${sessionId}`
}

const fallbackCache = new Map<string, { data: USSDSession, expires: number }>()

export async function getSession(sessionId: string): Promise<USSDSession | null> {
  if (redis) {
    try {
      const data = await redis.get<USSDSession>(sessionKey(sessionId))
      if (data) return data
    } catch (e) {
      console.error("[USSD-SESSION] get error:", e)
    }
  }

  // Fallback to in-memory cache
  const cached = fallbackCache.get(sessionId)
  if (cached && cached.expires > Date.now()) {
    return cached.data
  }
  return null
}

export async function setSession(sessionId: string, session: USSDSession): Promise<void> {
  if (redis) {
    try {
      await redis.setex(sessionKey(sessionId), SESSION_TTL, JSON.stringify(session))
      return
    } catch (e) {
      console.error("[USSD-SESSION] set error:", e)
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
      console.error("[USSD-SESSION] delete error:", e)
    }
  }
  fallbackCache.delete(sessionId)
}
