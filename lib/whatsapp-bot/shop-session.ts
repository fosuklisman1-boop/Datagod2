import { Redis } from "@upstash/redis"
import { WaShopSession } from "./shop-types"

// 30 minutes, not the USSD shop's 120s — WhatsApp is asynchronous (the customer
// can take their time between messages), unlike a live USSD dial session which
// times out the moment the gateway drops the call.
const SESSION_TTL = 1800 // seconds

let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  } else {
    console.warn("[WA-SHOP-SESSION] Upstash env vars not set — sessions will not persist")
  }
} catch (e) {
  console.error("[WA-SHOP-SESSION] Failed to initialise Redis:", e)
}

function sessionKey(phone: string): string {
  return `wa-shop:session:${phone}`
}

const fallbackCache = new Map<string, { data: WaShopSession, expires: number }>()

export async function getSession(phone: string): Promise<WaShopSession | null> {
  if (redis) {
    try {
      const data = await redis.get<WaShopSession>(sessionKey(phone))
      if (data) return data
    } catch (e) {
      console.error("[WA-SHOP-SESSION] get error:", e)
    }
  }

  // Fallback to in-memory cache
  const cached = fallbackCache.get(phone)
  if (cached && cached.expires > Date.now()) {
    return cached.data
  }
  return null
}

export async function setSession(phone: string, session: WaShopSession): Promise<void> {
  if (redis) {
    try {
      await redis.setex(sessionKey(phone), SESSION_TTL, JSON.stringify(session))
      return
    } catch (e) {
      console.error("[WA-SHOP-SESSION] set error:", e)
    }
  }

  // Fallback to in-memory cache
  fallbackCache.set(phone, { data: session, expires: Date.now() + SESSION_TTL * 1000 })
}

export async function deleteSession(phone: string): Promise<void> {
  if (redis) {
    try {
      await redis.del(sessionKey(phone))
    } catch (e) {
      console.error("[WA-SHOP-SESSION] delete error:", e)
    }
  }
  fallbackCache.delete(phone)
}
