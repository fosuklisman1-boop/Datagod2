import { Ratelimit } from "@upstash/ratelimit"
import { Redis } from "@upstash/redis"
import { NextRequest } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Upstash Redis client — used only if env vars are set
let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  } else {
    console.warn("[RATE-LIMIT] UPSTASH_REDIS_REST_URL / TOKEN not set — rate limiting disabled (fail open)")
  }
} catch (e) {
  console.error("[RATE-LIMIT] Failed to initialise Upstash Redis:", e)
}

// Supabase client for writing block logs
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Cache Ratelimit instances keyed by "maxRequests:windowSeconds"
// Each instance holds only config — actual state lives in Redis
const limiterCache = new Map<string, Ratelimit>()

function getLimiter(maxRequests: number, windowMs: number): Ratelimit {
  const windowSeconds = Math.max(1, Math.round(windowMs / 1000))
  const cacheKey = `${maxRequests}:${windowSeconds}`

  if (!limiterCache.has(cacheKey)) {
    limiterCache.set(
      cacheKey,
      new Ratelimit({
        redis: redis!,
        limiter: Ratelimit.slidingWindow(maxRequests, `${windowSeconds} s`),
        analytics: true,
        prefix: "rl",
      })
    )
  }

  return limiterCache.get(cacheKey)!
}

/**
 * Get client identifier from request (user ID takes priority over IP)
 */
export function getClientIdentifier(request: NextRequest, userId?: string): string {
  if (userId) return `user:${userId}`

  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0] ||
    "unknown"

  return `ip:${ip}`
}

/**
 * Apply rate limiting to a route.
 * Fails open if Upstash is unavailable — never block customers due to infra issues.
 */
export async function applyRateLimit(
  request: NextRequest,
  endpointName: string,
  maxRequests: number,
  windowMs: number,
  userId?: string
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  // No Redis configured — fail open
  if (!redis) {
    return { allowed: true, remaining: maxRequests, resetAt: Date.now() + windowMs }
  }

  try {
    const identifier = getClientIdentifier(request, userId)
    const limiter = getLimiter(maxRequests, windowMs)
    const key = `${endpointName}:${identifier}`

    const { success, remaining, reset } = await limiter.limit(key)

    if (!success) {
      console.warn(`[RATE-LIMIT] Blocked ${endpointName}`, {
        identifier,
        limit: maxRequests,
        window: `${Math.round(windowMs / 1000)}s`,
      })

      // Write block log to Supabase (non-blocking, best-effort)
      supabase
        .from("rate_limit_blocks")
        .insert({
          endpoint: endpointName,
          identifier,
          request_limit: maxRequests,
          window_seconds: Math.round(windowMs / 1000),
          blocked_at: new Date().toISOString(),
        })
        .then(({ error }) => {
          if (error) console.warn("[RATE-LIMIT] Failed to log block:", error.message)
        })
    }

    return { allowed: success, remaining, resetAt: reset }
  } catch (error) {
    // Fail open — Upstash down should never block legitimate traffic
    console.error("[RATE-LIMIT] Upstash error, failing open:", error)
    return { allowed: true, remaining: 1, resetAt: Date.now() + windowMs }
  }
}
