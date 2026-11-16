// lib/rate-limit-fallback.ts
// Postgres fixed-window counter used when Redis is unavailable (opt-in, see applyRateLimit's pgFallback option).
// Backed by the rate_limit_fallback_hit RPC (migration 0164, service_role only). Never throws.
import { createClient } from "@supabase/supabase-js"

export type PgFallbackResult = { allowed: boolean; remaining: number; resetAt: number }

export async function pgFallbackLimit(bucket: string, max: number, windowMs: number): Promise<PgFallbackResult | null> {
  try {
    const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000))
    const { data, error } = await client.rpc("rate_limit_fallback_hit", {
      p_bucket: bucket,
      p_max: max,
      p_window_seconds: windowSeconds,
    })
    if (error) {
      console.warn("[RATE-LIMIT] Postgres fallback error:", error.message)
      return null
    }
    const row = Array.isArray(data) ? data[0] : data
    if (!row || typeof row.allowed !== "boolean" || typeof row.remaining !== "number") return null
    const resetAt = Date.parse(String(row.reset_at))
    if (!Number.isFinite(resetAt)) return null
    return { allowed: row.allowed, remaining: row.remaining, resetAt }
  } catch (e) {
    console.warn("[RATE-LIMIT] Postgres fallback failed:", e instanceof Error ? e.message : "unknown error")
    return null
  }
}
