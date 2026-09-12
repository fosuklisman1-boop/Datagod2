import { Redis } from "@upstash/redis"
import { supabaseAdmin } from "@/lib/supabase"
import { normalizeDomainHost, type CustomDomainConfig } from "@/lib/custom-domains"

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null

// Positive-hit TTL — a safety net against a missed cache invalidation, not the
// primary invalidation mechanism (the admin route write-throughs on save/delete).
const CACHE_TTL_SECONDS = 5 * 60 // 300s

// Negative-hit ("this host has no custom domain") TTL. Deliberately much
// shorter than CACHE_TTL_SECONDS (60s vs 300s) so a domain an admin just added
// doesn't stay invisible anywhere near as long as a positive hit stays cached.
const NEGATIVE_CACHE_TTL_SECONDS = 60

// Cached in place of a real config to remember "we already checked — there's no
// active row for this exact host" without re-querying Supabase on every request
// to an unmapped host.
const NOT_FOUND_MARKER = "__none__" as const

const cacheKey = (domain: string) => `custom_domain:${domain}`

// Toggles the "www." prefix on a host: strips it if present, adds it otherwise.
// An admin's custom-domain form strips a leading "www." before storing (see
// app/api/admin/custom-domains/route.ts's normalizeDomainInput), but real
// traffic may arrive with either form depending on how the domain is attached
// in Vercel/DNS — so a miss on the exact host is retried once against this
// toggled variant before giving up.
function toggleWwwVariant(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : `www.${host}`
}

type LookupResult =
  | { kind: "found"; config: CustomDomainConfig }
  | { kind: "not_found"; fromNegativeCache: boolean }
  | { kind: "error" }

function cacheSetPositive(host: string, config: CustomDomainConfig): void {
  if (!redis) return
  redis.set(cacheKey(host), config, { ex: CACHE_TTL_SECONDS }).catch(e =>
    console.error("[CUSTOM-DOMAIN-LOOKUP] Redis cache-fill failed (non-fatal):", e instanceof Error ? e.message : e)
  )
}

function cacheSetNegative(host: string): void {
  if (!redis) return
  redis.set(cacheKey(host), NOT_FOUND_MARKER, { ex: NEGATIVE_CACHE_TTL_SECONDS }).catch(e =>
    console.error("[CUSTOM-DOMAIN-LOOKUP] Redis negative-cache write failed (non-fatal):", e instanceof Error ? e.message : e)
  )
}

// Cache-then-Supabase lookup for exactly the given host string (no www toggling
// here — that's orchestrated by resolveCustomDomain below). Populates the cache
// on a genuine Supabase hit or miss. A Redis/Supabase error is reported as
// "error" so callers can fail open without contaminating the cache with a false
// negative.
async function lookupExact(host: string): Promise<LookupResult> {
  if (redis) {
    try {
      const cached = await redis.get<CustomDomainConfig | typeof NOT_FOUND_MARKER>(cacheKey(host))
      if (cached === NOT_FOUND_MARKER) return { kind: "not_found", fromNegativeCache: true }
      if (cached) return { kind: "found", config: cached }
    } catch (e) {
      console.error("[CUSTOM-DOMAIN-LOOKUP] Redis read failed, falling back to Supabase:", e instanceof Error ? e.message : e)
    }
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("custom_domains")
      .select("domain, services, site_name, logo_url, primary_color, is_active")
      .eq("domain", host)
      .eq("is_active", true)
      .maybeSingle()

    if (error) {
      console.error("[CUSTOM-DOMAIN-LOOKUP] Supabase lookup failed:", error)
      return { kind: "error" }
    }
    if (!data) return { kind: "not_found", fromNegativeCache: false }

    const config = data as CustomDomainConfig
    cacheSetPositive(host, config)
    return { kind: "found", config }
  } catch (e) {
    console.error("[CUSTOM-DOMAIN-LOOKUP] Supabase lookup failed:", e instanceof Error ? e.message : e)
    return { kind: "error" }
  }
}

/**
 * Resolve a custom domain's config. Callers decide when this is worth calling
 * (e.g. middleware skips it entirely for the root domain, its subdomains,
 * localhost, and Vercel aliases — see middleware.ts's isMainAppHost guard — so
 * none of those hosts pay any Redis/Supabase cost at all, not even a
 * cached-negative one).
 *
 * On a definitive miss for the exact host (a fresh Supabase query found no
 * active row — NOT a cache hit on an already-negative-cached host, which
 * short-circuits immediately since that outcome was already conclusive for
 * both forms), also tries the www-toggled variant once before giving up: an
 * admin's custom-domain form strips a leading "www." on save, but real traffic
 * may arrive with either form. This is at most one extra cache+Supabase
 * attempt, never more.
 *
 * Fails open (returns null, meaning "render the main site normally") on any
 * Redis or Supabase error, and on a host with no active row under either form.
 */
export async function resolveCustomDomain(host: string): Promise<CustomDomainConfig | null> {
  const primary = await lookupExact(host)
  if (primary.kind === "found") return primary.config
  if (primary.kind === "error") return null
  if (primary.fromNegativeCache) return null // already conclusively resolved for both forms previously

  // Primary form definitively has no active row (a fresh, non-error miss) —
  // try the www-toggled variant before concluding this host has no custom domain.
  const altHost = toggleWwwVariant(host)
  const alt = await lookupExact(altHost)
  if (alt.kind === "found") {
    // Mirror the hit under the originally-requested host's own cache key too,
    // so a repeat request in this exact form is a straight cache hit next time.
    cacheSetPositive(host, alt.config)
    return alt.config
  }

  // Both forms are either genuinely absent or unreachable — negative-cache only
  // the forms we're actually sure about (an "error" outcome is never cached).
  if (alt.kind === "not_found") cacheSetNegative(altHost)
  cacheSetNegative(host)
  return null
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

/**
 * Called by the admin API route on delete, or when is_active flips to false.
 * Also clears the www-toggled variant's key — resolveCustomDomain may have
 * mirrored a positive hit there (see above), and a stale mirrored entry
 * shouldn't outlive the row it was resolved from.
 */
export async function clearCustomDomainCache(domain: string): Promise<void> {
  if (!redis) return
  try {
    await Promise.all([
      redis.del(cacheKey(domain)),
      redis.del(cacheKey(toggleWwwVariant(domain))),
    ])
  } catch (e) {
    console.error("[CUSTOM-DOMAIN-LOOKUP] Redis cache clear failed (non-fatal):", e instanceof Error ? e.message : e)
  }
}

function defaultBaseUrlFallback(): string {
  return process.env.NEXT_PUBLIC_APP_URL
    ? process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000"
}

/**
 * Resolve the base URL a server-generated customer-facing redirect (e.g. a
 * Paystack post-payment return URL) should use — this is deliberately NOT
 * "whatever the request claims," to avoid an open-redirect/phishing risk.
 *
 * SECURITY: never build such a redirect from the request's Origin header —
 * it's set by whatever page made the fetch call and is fully
 * attacker-controlled for a cross-origin request (a phishing site could POST
 * to a payment-init endpoint with an arbitrary Origin and steer the
 * post-payment redirect to itself).
 *
 * The Host header is a different trust boundary: Vercel's own edge routing
 * (TLS SNI + Host) only ever delivers a request to this deployment under a
 * host that's genuinely attached to this Vercel project, so it can't be
 * forged into an arbitrary third-party domain the way Origin can. Even so,
 * this stays conservative and only trusts it two ways: the exact root
 * domain (the existing NEXT_PUBLIC_APP_URL/VERCEL_URL/localhost fallback),
 * or a host that matches an admin-configured ACTIVE row in custom_domains —
 * never an arbitrary attached-but-unintended host (e.g. a raw *.vercel.app
 * preview alias).
 */
export async function resolveTrustedBaseUrl(host: string | null): Promise<string> {
  const normalized = normalizeDomainHost(host)
  const rootDomain = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "datagod.store").toLowerCase()
  if (!normalized || normalized === rootDomain) return defaultBaseUrlFallback()

  const customDomain = await resolveCustomDomain(normalized)
  return customDomain ? `https://${normalized}` : defaultBaseUrlFallback()
}
