// Server-side config for order-time network-prefix validation.
// The prefix map is admin-editable (admin_settings.network_prefix_map) and
// also drives the SQL classifier gh_is_mtn — see
// migrations/20260707_network_prefix_map.sql. lib/phone-format.ts stays
// Supabase-free (client-safe), so the readers live here.
import { createClient } from "@supabase/supabase-js"
import { DEFAULT_NETWORK_PREFIXES, type NetworkPrefixMap } from "./phone-format"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export const PREFIX_MAP_KEY = "network_prefix_map"
export const PREFIX_TOGGLE_KEY = "network_prefix_validation_enabled"

function sanitizeMap(raw: unknown): NetworkPrefixMap {
  const out: NetworkPrefixMap = {
    MTN: [...DEFAULT_NETWORK_PREFIXES.MTN],
    TELECEL: [...DEFAULT_NETWORK_PREFIXES.TELECEL],
    AT: [...DEFAULT_NETWORK_PREFIXES.AT],
  }
  if (raw && typeof raw === "object") {
    for (const net of ["MTN", "TELECEL", "AT"] as const) {
      const v = (raw as Record<string, unknown>)[net]
      if (Array.isArray(v)) {
        const cleaned = v.map(String).filter(p => /^[2-9]\d$/.test(p))
        if (cleaned.length > 0) out[net] = cleaned
      }
    }
  }
  return out
}

export interface PrefixValidationConfig {
  enabled: boolean
  map: NetworkPrefixMap
}

/**
 * One query for both settings. Defaults: enabled=true (only an explicit
 * enabled:false disables), map=DEFAULT_NETWORK_PREFIXES merged per-network.
 * Fails toward validating with defaults — validation is cheap and blocking a
 * mismatch is the safe behavior.
 */
export async function getPrefixValidationConfig(): Promise<PrefixValidationConfig> {
  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey)
    const { data, error } = await supabase
      .from("admin_settings")
      .select("key, value")
      .in("key", [PREFIX_MAP_KEY, PREFIX_TOGGLE_KEY])
    if (error) throw error
    const rows = new Map((data ?? []).map(r => [r.key, r.value]))
    const toggle = rows.get(PREFIX_TOGGLE_KEY) as { enabled?: boolean } | undefined
    return {
      enabled: toggle?.enabled !== false,
      map: sanitizeMap(rows.get(PREFIX_MAP_KEY)),
    }
  } catch (err) {
    console.error("[PREFIX-CONFIG] read failed — using defaults (enabled):", err)
    return { enabled: true, map: DEFAULT_NETWORK_PREFIXES }
  }
}
