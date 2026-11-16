// lib/mtn-providers/verdict-cache.ts
// Cache of DEFINITE customer-verification verdicts, shared by every ordering endpoint
// (web, API v1/v2, USSD, WhatsApp, AI ordering, the checkout preview).
//
//   verified (true)  -> kept FOREVER, keyed by the number alone: once any selected
//                       provider has approved a number it is never re-checked, even
//                       if the provider list changes later.
//   rejected (false) -> kept 10 minutes, keyed by the ordered provider list + number,
//                       so a number that gets registered can pass soon after, and a
//                       provider change re-checks it at once.
// Unchecked results (outage / timeout) are never stored.
//
// Backend: Upstash Redis when configured, otherwise the Supabase table
// mtn_verdict_cache (migration 0143; verified rows use expires_at = 'infinity').
// Any backend error is a cache miss. To forget a verified number, delete its
// "mtnverify:ok:<last 9 digits>" key / row.
import { Redis } from "@upstash/redis"
import { getRedisRestEnv } from "@/lib/redis-env"
import { supabaseAdmin } from "@/lib/supabase"

/** How long a REJECTION is remembered. Verified numbers never expire. */
export const VERDICT_TTL_SECONDS = 600
const TABLE = "mtn_verdict_cache"
const FOREVER = "infinity"
/** Expired rows are deleted on roughly 1 write in this many. */
const PURGE_EVERY = 50

let redis: Redis | null = null
try {
  const redisEnv = getRedisRestEnv()
  if (redisEnv) {
    redis = new Redis({ url: redisEnv.url, token: redisEnv.token })
  }
} catch (e) {
  console.error("[VERDICT-CACHE] Failed to initialise Redis:", e instanceof Error ? e.name : "UnknownError")
}

/** Last 9 digits: the same number in 0XXXXXXXXX / 233XXXXXXXXX / +233 form shares a key. */
const last9 = (phone: string) => phone.replace(/\D/g, "").slice(-9)

/** Permanent "verified" entry: the number alone, independent of the provider list. */
export function verifiedCacheKey(phone: string): string {
  return `mtnverify:ok:${last9(phone)}`
}

/** Short-lived "rejected" entry: scoped to the ordered provider list that rejected it. */
export function verdictCacheKey(phone: string, providers: string[]): string {
  return `mtnverify:v1:${providers.join(",")}:${last9(phone)}`
}

/** Never the key itself: it contains the phone number. */
function logMiss(op: string, e: unknown) {
  const code = (e as { code?: string } | null)?.code
  console.warn(`[VERDICT-CACHE] ${op} failed (cache miss):`, code ?? (e instanceof Error ? e.name : "UnknownError"))
}

export async function getCachedVerdicts(phones: string[], providers: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  if (phones.length === 0) return out
  const okKeys = phones.map(verifiedCacheKey)
  const noKeys = phones.map(p => verdictCacheKey(p, providers))
  const isTrue = (v: unknown) => v === "1" || v === 1 || v === true
  const isFalse = (v: unknown) => v === "0" || v === 0 || v === false
  try {
    if (redis) {
      const values = await redis.mget<(string | number | boolean | null)[]>(...okKeys, ...noKeys)
      phones.forEach((p, i) => {
        if (isTrue(values[i])) out.set(p, true)
        else if (isFalse(values[phones.length + i])) out.set(p, false)
      })
      return out
    }
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select("cache_key, verdict")
      .in("cache_key", [...new Set([...okKeys, ...noKeys])])
      .gt("expires_at", new Date().toISOString())
    if (error) throw error
    const byKey = new Map<string, boolean>((data ?? []).map((r: { cache_key: string; verdict: boolean }) => [r.cache_key, r.verdict]))
    phones.forEach((p, i) => {
      if (byKey.get(okKeys[i]) === true) out.set(p, true)
      else if (byKey.get(noKeys[i]) === false) out.set(p, false)
    })
  } catch (e) {
    logMiss("read", e)
  }
  return out
}

export async function setCachedVerdicts(verdicts: Map<string, boolean>, providers: string[]): Promise<void> {
  if (verdicts.size === 0) return
  const entries = [...verdicts].map(([p, v]) => (v
    ? { key: verifiedCacheKey(p), verdict: true }
    : { key: verdictCacheKey(p, providers), verdict: false }))
  try {
    if (redis) {
      await Promise.all(entries.map(e => (e.verdict
        ? redis!.set(e.key, "1")
        : redis!.setex(e.key, VERDICT_TTL_SECONDS, "0"))))
      return
    }
    const rejectedUntil = new Date(Date.now() + VERDICT_TTL_SECONDS * 1000).toISOString()
    const rows = [...new Map(entries.map(e => [e.key, e]))].map(([cache_key, e]) => ({
      cache_key,
      verdict: e.verdict,
      expires_at: e.verdict ? FOREVER : rejectedUntil,
    }))
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
