import { Redis } from "@upstash/redis"
import { supabaseAdmin } from "@/lib/supabase"
import type { CustomDomainConfig } from "@/lib/custom-domains"

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null

const CACHE_TTL_SECONDS = 5 * 60
const cacheKey = (domain: string) => `custom_domain:${domain}`

/**
 * Resolve a custom domain's config. Callers decide when this is worth calling
 * (e.g. middleware skips it entirely for the root domain and shop subdomains).
 * Fails open (returns null, meaning "render the main site normally") on any
 * Redis or Supabase error, and on a domain with no active row.
 */
export async function resolveCustomDomain(host: string): Promise<CustomDomainConfig | null> {
  if (redis) {
    try {
      const cached = await redis.get<CustomDomainConfig>(cacheKey(host))
      if (cached) return cached
    } catch (e) {
      console.error("[CUSTOM-DOMAIN-LOOKUP] Redis read failed, falling back to Supabase:", e instanceof Error ? e.message : e)
    }
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("custom_domains")
      .select("domain, service, site_name, logo_url, primary_color, is_active")
      .eq("domain", host)
      .eq("is_active", true)
      .maybeSingle()

    if (error || !data) return null

    const config = data as CustomDomainConfig
    if (redis) {
      redis.set(cacheKey(host), config, { ex: CACHE_TTL_SECONDS }).catch(e =>
        console.error("[CUSTOM-DOMAIN-LOOKUP] Redis cache-fill failed (non-fatal):", e instanceof Error ? e.message : e)
      )
    }
    return config
  } catch (e) {
    console.error("[CUSTOM-DOMAIN-LOOKUP] Supabase lookup failed:", e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Write-through cache update — called by the admin API route right after a
 * successful create/update so the change is live immediately instead of
 * waiting on CACHE_TTL_SECONDS.
 */
export async function setCustomDomainCache(config: CustomDomainConfig): Promise<void> {
  if (!redis) return
  try {
    await redis.set(cacheKey(config.domain), config, { ex: CACHE_TTL_SECONDS })
  } catch (e) {
    console.error("[CUSTOM-DOMAIN-LOOKUP] Redis cache write failed (non-fatal):", e instanceof Error ? e.message : e)
  }
}

/** Called by the admin API route on delete, or when is_active flips to false. */
export async function clearCustomDomainCache(domain: string): Promise<void> {
  if (!redis) return
  try {
    await redis.del(cacheKey(domain))
  } catch (e) {
    console.error("[CUSTOM-DOMAIN-LOOKUP] Redis cache clear failed (non-fatal):", e instanceof Error ? e.message : e)
  }
}
