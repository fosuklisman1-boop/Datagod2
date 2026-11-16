/**
 * Single place that decides which Upstash Redis REST credentials the app uses.
 *
 * Two pairs can exist on Vercel:
 *   - UPSTASH_REDIS_REST_URL / _TOKEN  — a database on our own Upstash account
 *   - KV_REST_API_URL / KV_REST_API_TOKEN — the Vercel Marketplace Upstash store
 *     (upstash-kv-champagne-cable), injected by the integration
 *
 * UPSTASH_* stays the default so linking/suspending the Vercel store can never
 * silently move sessions. Setting REDIS_SOURCE=vercel-kv (plus a redeploy)
 * switches every caller to the KV pair; an incomplete KV pair falls back to UPSTASH_*.
 * The KV read-only token is never used — callers write.
 */
export type RedisRestEnv = { url: string; token: string; source: "upstash" | "vercel-kv" }

type Env = Record<string, string | undefined>

export function getRedisRestEnv(env: Env = process.env): RedisRestEnv | null {
  const kv =
    env.KV_REST_API_URL && env.KV_REST_API_TOKEN
      ? { url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN, source: "vercel-kv" as const }
      : null
  const upstash =
    env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
      ? { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN, source: "upstash" as const }
      : null

  // KV is strictly opt-in: with REDIS_SOURCE unset a KV-only environment stays unconfigured,
  // exactly as before this helper existed.
  const preferKv = (env.REDIS_SOURCE ?? "").trim().toLowerCase() === "vercel-kv"
  return preferKv ? kv ?? upstash : upstash
}

export function isRedisRestConfigured(env: Env = process.env): boolean {
  return getRedisRestEnv(env) !== null
}
