// lib/whatsapp-bot/rate-limit.ts
//
// Per-sender inbound cap for the WhatsApp bot. Each inbound message can trigger
// an AI run (tokens) + tool calls, so a single number spamming the bot is a cost
// + abuse vector. 20/min is far above human pace — only automation hits it.
import { Redis } from "@upstash/redis"

let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  }
} catch { /* no redis → fail open (don't block legit users) */ }

const MAX_PER_MINUTE = 20

/** True if this sender is under the inbound cap. Fails OPEN if Redis is down. */
export async function allowInbound(waPhone: string): Promise<boolean> {
  if (!redis || !waPhone) return true
  try {
    const key = `wa:rate:${waPhone}`
    // INCR + EXPIRE in one pipeline so a crash between them can't leave the key
    // without a TTL (which would permanently block the sender).
    const [n] = (await redis.pipeline().incr(key).expire(key, 60).exec()) as [number, unknown]
    return Number(n) <= MAX_PER_MINUTE
  } catch {
    return true
  }
}
