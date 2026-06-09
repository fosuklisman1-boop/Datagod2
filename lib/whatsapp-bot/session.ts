// lib/whatsapp-bot/session.ts
import { Redis } from "@upstash/redis"
import { USSDSession } from "@/lib/ussd/types"

const WA_SESSION_TTL = 1800 // 30 minutes

let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  }
} catch (e) {
  console.error("[WA-SESSION] Failed to initialise Redis:", e)
}

// Same key format as lib/ussd/session.ts — USSD handlers call setSession(sessionId, ...)
// which writes to this same key, so handler state changes are visible here.
function sessionKey(phone: string): string {
  return `ussd:session:${phone}`
}

export async function getWaSession(phone: string): Promise<USSDSession | null> {
  if (!redis) return null
  try {
    return await redis.get<USSDSession>(sessionKey(phone))
  } catch (e) {
    console.error("[WA-SESSION] get error:", e)
    return null
  }
}

export async function setWaSession(phone: string, session: USSDSession): Promise<void> {
  if (!redis) return
  try {
    await redis.setex(sessionKey(phone), WA_SESSION_TTL, JSON.stringify(session))
  } catch (e) {
    console.error("[WA-SESSION] set error:", e)
  }
}

export async function deleteWaSession(phone: string): Promise<void> {
  if (!redis) return
  try {
    await redis.del(sessionKey(phone))
  } catch (e) {
    console.error("[WA-SESSION] delete error:", e)
  }
}

// Called after every USSD handler to restore the 30-min TTL
// (handlers internally call setSession which resets TTL to 120 s)
export async function extendWaSession(phone: string): Promise<void> {
  if (!redis) return
  try {
    await redis.expire(sessionKey(phone), WA_SESSION_TTL)
  } catch (e) {
    console.error("[WA-SESSION] extend error:", e)
  }
}
