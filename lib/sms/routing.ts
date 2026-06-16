/**
 * DB-configurable SMS provider routing.
 *
 * Reads `admin_settings` rows `sms_primary_provider` and
 * `sms_fallback_providers` (JSON array string).  Falls back to env vars
 * (SMS_PROVIDER / SMS_FALLBACK_PROVIDER) so existing deployments are
 * unaffected before the DB rows are seeded.
 *
 * Un-metered broadcast path — no credit helpers imported.
 */

import { createClient } from "@supabase/supabase-js"

const VALID_PROVIDERS = ["moolre", "mnotify", "brevo"] as const
type Provider = (typeof VALID_PROVIDERS)[number]

export interface RoutingConfig {
  primary: Provider | string
  fallbacks: (Provider | string)[]
}

// ---------------------------------------------------------------------------
// parseRoutingConfig — pure; exported for unit tests
// ---------------------------------------------------------------------------

interface SettingRow {
  key: string
  value: string | string[] | unknown
}

export function parseRoutingConfig(rows: SettingRow[]): RoutingConfig {
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))

  const rawPrimary = map["sms_primary_provider"]
  const primary =
    (typeof rawPrimary === "string" ? rawPrimary : null) ||
    (process.env.SMS_PROVIDER as Provider) ||
    "moolre"

  let fallbacks: (Provider | string)[] = []
  const rawFallbacks = map["sms_fallback_providers"]
  try {
    if (Array.isArray(rawFallbacks)) {
      // Supabase returns JSONB already parsed as an array
      fallbacks = rawFallbacks.filter((p: unknown) => VALID_PROVIDERS.includes(p as Provider))
    } else {
      const raw =
        (typeof rawFallbacks === "string" ? rawFallbacks : null) ??
        process.env.SMS_FALLBACK_PROVIDER ??
        '["mnotify"]'
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        fallbacks = parsed.filter((p: unknown) => VALID_PROVIDERS.includes(p as Provider))
      }
    }
  } catch {
    fallbacks = []
  }

  return { primary, fallbacks }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000

let _cached: RoutingConfig | null = null
let _cachedAt = 0

export function invalidateRoutingCache(): void {
  _cached = null
  _cachedAt = 0
}

export async function getRoutingConfig(): Promise<RoutingConfig> {
  if (_cached && Date.now() - _cachedAt < CACHE_TTL_MS) return _cached

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data, error } = await supabase
      .from("admin_settings")
      .select("key, value")
      .in("key", ["sms_primary_provider", "sms_fallback_providers"])

    if (error) throw error

    _cached = parseRoutingConfig(data ?? [])
    _cachedAt = Date.now()
    return _cached
  } catch {
    // On any DB error, fall back to env / defaults without poisoning the cache
    return parseRoutingConfig([])
  }
}
