// Single JSON blob in admin_settings (key/value convention — NOT the app_settings
// singleton row; see the app_settings table-collision incident). Caller owns the client.
import type { SupabaseClient } from "@supabase/supabase-js"

export const HUBTEL_USSD_CONFIG_KEY = "hubtel_ussd_config"

export interface HubtelUssdConfig {
  enabled: boolean
  mode: "main" | "shop"
  visibility: { data: boolean; afa: boolean; airtime: boolean; resultsChecker: boolean }
}

const DEFAULT_CONFIG: HubtelUssdConfig = {
  enabled: false,
  mode: "main",
  visibility: { data: true, afa: true, airtime: true, resultsChecker: true },
}

const REQUIRED_ENV = ["HUBTEL_WEBHOOK_SECRET", "HUBTEL_RELAY_URL", "HUBTEL_RELAY_SECRET"] as const

/** The channel may only be enabled when every Hubtel env var is set (empty counts as missing). */
export function hubtelEnvReady(
  env: Record<string, string | undefined> = process.env
): { ready: boolean; missing: string[] } {
  const missing = REQUIRED_ENV.filter(k => !env[k])
  return { ready: missing.length === 0, missing }
}

export async function getHubtelUssdConfig(supabase: SupabaseClient): Promise<HubtelUssdConfig> {
  const { data, error } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", HUBTEL_USSD_CONFIG_KEY)
    .maybeSingle()
  if (error) throw error
  const stored = data?.value && typeof data.value === "object" ? (data.value as Partial<HubtelUssdConfig>) : {}
  return {
    // Only an explicit `true` enables the channel.
    enabled: stored.enabled === true,
    mode: stored.mode === "shop" ? "shop" : "main",
    visibility: { ...DEFAULT_CONFIG.visibility, ...(stored.visibility ?? {}) },
  }
}

export async function setHubtelUssdConfig(
  supabase: SupabaseClient,
  patch: { enabled?: boolean; mode?: "main" | "shop"; visibility?: Partial<HubtelUssdConfig["visibility"]> }
): Promise<HubtelUssdConfig> {
  if (patch.mode !== undefined && patch.mode !== "main" && patch.mode !== "shop") {
    throw new Error("invalid mode")
  }
  const current = await getHubtelUssdConfig(supabase)
  const next: HubtelUssdConfig = {
    enabled: patch.enabled ?? current.enabled,
    mode: patch.mode ?? current.mode,
    visibility: { ...current.visibility, ...(patch.visibility ?? {}) },
  }
  const { error } = await supabase.from("admin_settings").upsert(
    {
      key: HUBTEL_USSD_CONFIG_KEY,
      value: next,
      description: "Hubtel USSD channel: kill switch, main/shop mode, per-service visibility.",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  )
  if (error) throw error
  return next
}
