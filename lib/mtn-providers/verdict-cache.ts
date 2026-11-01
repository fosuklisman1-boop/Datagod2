// lib/mtn-providers/verdict-cache.ts
// Short-lived cache of DEFINITE customer-verification verdicts (true verified /
// false rejected) per number, so a check that outlives one request (USSD screens
// cap it at a few seconds) still answers the next one. Unchecked results are never
// stored. The key includes the ordered provider list, so changing the providers
// in admin starts fresh.
//
// Backend: Upstash Redis when configured, otherwise the Supabase table
// mtn_verdict_cache (migration 0143). Any backend error is a cache miss.
import { Redis } from "@upstash/redis"
import { supabaseAdmin } from "@/lib/supabase"

export const VERDICT_TTL_SECONDS = 600
const TABLE = "mtn_verdict_cache"
/** Expired rows are deleted on roughly 1 write in this many. */
const PURGE_EVERY = 50

let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  }
} catch (e) {
  console.error("[VERDICT-CACHE] Failed to initialise Redis:", e instanceof Error ? e.name : "UnknownError")
}

/** Last 9 digits: the same number in 0XXXXXXXXX / 233XXXXXXXXX / +233 form shares a key. */
export function verdictCacheKey(phone: string, providers: string[]): string {
  const digits = phone.replace(/\D/g, "")
  return `mtnverify:v1:${providers.join(",")}:${digits.slice(-9)}`
}

/** Never the key itself: it contains the phone number. */
function logMiss(op: string, e: unknown) {
  const code = (e as { code?: string } | null)?.code
  console.warn(`[VERDICT-CACHE] ${op} failed (cache miss):`, code ?? (e instanceof Error ? e.name : "UnknownError"))
}

export async function getCachedVerdicts(phones: string[], providers: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  if (phones.length === 0) return out
  const keys = phones.map(p => verdictCacheKey(p, providers))
  try {
    if (redis) {
      const values = await redis.mget<(string | number | boolean | null)[]>(...keys)
      phones.forEach((p, i) => {
        const v = values[i]
        if (v === "1" || v === 1 || v === true) out.set(p, true)
        else if (v === "0" || v === 0 || v === false) out.set(p, false)
      })
      return out
    }
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select("cache_key, verdict")
      .in("cache_key", [...new Set(keys)])
      .gt("expires_at", new Date().toISOString())
    if (error) throw error
    const byKey = new Map<string, boolean>((data ?? []).map((r: { cache_key: string; verdict: boolean }) => [r.cache_key, r.verdict]))
    phones.forEach((p, i) => {
      const v = byKey.get(keys[i])
      if (typeof v === "boolean") out.set(p, v)
    })
  } catch (e) {
    logMiss("read", e)
  }
  return out
}

export async function setCachedVerdicts(verdicts: Map<string, boolean>, providers: string[]): Promise<void> {
  if (verdicts.size === 0) return
  try {
    if (redis) {
      await Promise.all(
        [...verdicts].map(([p, v]) => redis!.setex(verdictCacheKey(p, providers), VERDICT_TTL_SECONDS, v ? "1" : "0"))
      )
      return
    }
    const expiresAt = new Date(Date.now() + VERDICT_TTL_SECONDS * 1000).toISOString()
    const rows = [...new Map([...verdicts].map(([p, v]) => [verdictCacheKey(p, providers), v]))].map(
      ([cache_key, verdict]) => ({ cache_key, verdict, expires_at: expiresAt })
    )
    const { error } = await supabaseAdmin.from(TABLE).upsert(rows, { onConflict: "cache_key" })
    if (error) throw error
    if (Math.random() < 1 / PURGE_EVERY) {
      const { error: purgeError } = await supabaseAdmin.from(TABLE).delete().lt("expires_at", new Date().toISOString())
      if (purgeError) logMiss("purge", purgeError)
    }
  } catch (e) {
    logMiss("write", e)
  }
}
