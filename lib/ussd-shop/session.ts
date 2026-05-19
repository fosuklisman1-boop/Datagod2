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

export async function getSession(sessionId: string): Promise<USSDShopSession | null> {
  if (!redis) return null
  try {
    const data = await redis.get<USSDShopSession>(sessionKey(sessionId))
    return data ?? null
  } catch (e) {
    console.error("[USSD-SHOP-SESSION] get error:", e)
    return null
  }
}

export async function setSession(sessionId: string, session: USSDShopSession): Promise<void> {
  if (!redis) return
  try {
    await redis.setex(sessionKey(sessionId), SESSION_TTL, JSON.stringify(session))
  } catch (e) {
    console.error("[USSD-SHOP-SESSION] set error:", e)
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  if (!redis) return
  try {
    await redis.del(sessionKey(sessionId))
  } catch (e) {
    console.error("[USSD-SHOP-SESSION] delete error:", e)
  }
}
