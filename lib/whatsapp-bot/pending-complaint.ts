// lib/whatsapp-bot/pending-complaint.ts
//
// A complaint that has been gathered by the bot but NOT yet logged — it is held
// here until the customer sends the mandatory screenshot. Only then does the
// webhook create the complaint (with the screenshot attached) and alert admins.
// Kept in its own Redis key (NOT the bot session) so it doesn't trip the session
// → waRouter routing. TTL-bounded so a never-completed staging eventually clears.
import { Redis } from "@upstash/redis"

let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  }
} catch { /* no redis → staging unavailable; file_complaint falls back (see handler) */ }

const TTL_SECONDS = 60 * 60 // 1h: ample for the customer to find + send a screenshot
const key = (waPhone: string) => `wa:pendingcomplaint:${waPhone}`

export interface PendingComplaint {
  summary: string
  category: string
  beneficiaryNumber?: string | null
  orderInfo?: string | null
}

export function pendingComplaintAvailable(): boolean {
  return redis !== null
}

export async function setPendingComplaint(waPhone: string, data: PendingComplaint): Promise<void> {
  if (!redis || !waPhone) return
  try {
    await redis.set(key(waPhone), data, { ex: TTL_SECONDS })
  } catch (e) {
    console.warn("[WA-PENDING-COMPLAINT] set failed:", e)
  }
}

export async function getPendingComplaint(waPhone: string): Promise<PendingComplaint | null> {
  if (!redis || !waPhone) return null
  try {
    return (await redis.get<PendingComplaint>(key(waPhone))) ?? null
  } catch {
    return null
  }
}

export async function clearPendingComplaint(waPhone: string): Promise<void> {
  if (!redis || !waPhone) return
  try {
    await redis.del(key(waPhone))
  } catch { /* best-effort */ }
}
