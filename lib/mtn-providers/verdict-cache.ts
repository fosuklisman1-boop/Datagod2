// lib/mtn-providers/verdict-cache.ts
// Short-lived cache of DEFINITE customer-verification verdicts (true verified /
// false rejected) per number, so a check that outlives one request (USSD screens
// cap it at a few seconds) still answers the next one. Unchecked results are never
// stored. The key includes the ordered provider list, so changing the providers
// in admin starts fresh. No Redis configured, or any Redis error = a cache miss.
import { Redis } from "@upstash/redis"

export const VERDICT_TTL_SECONDS = 600

let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  }
} catch (e) {
  console.error("[VERDICT-CACHE] Failed to initialise Redis:", e instanceof Error ? e.name : "UnknownError")
}

/** Last 9 digits: the same number in 0XXXXXXXXX / 233XXXXXXXXX / +233 form shares a key. */
function keyFor(phone: string, providers: string[]): string {
  const digits = phone.replace(/\D/g, "")
  return `mtnverify:v1:${providers.join(",")}:${digits.slice(-9)}`
}

export async function getCachedVerdicts(phones: string[], providers: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  if (!redis || phones.length === 0) return out
  try {
    const values = await redis.mget<(string | number | boolean | null)[]>(...phones.map(p => keyFor(p, providers)))
    phones.forEach((p, i) => {
      const v = values[i]
      if (v === "1" || v === 1 || v === true) out.set(p, true)
      else if (v === "0" || v === 0 || v === false) out.set(p, false)
    })
  } catch {
    // miss
  }
  return out
}

export async function setCachedVerdicts(verdicts: Map<string, boolean>, providers: string[]): Promise<void> {
  if (!redis || verdicts.size === 0) return
  try {
    await Promise.all(
      [...verdicts].map(([p, v]) => redis!.setex(keyFor(p, providers), VERDICT_TTL_SECONDS, v ? "1" : "0"))
    )
  } catch {
    // best effort
  }
}
