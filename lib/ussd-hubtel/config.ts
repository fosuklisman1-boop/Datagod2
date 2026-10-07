// Single JSON blob in admin_settings (key/value convention — NOT the app_settings
// singleton row; see the app_settings table-collision incident). Caller owns the client.
import type { SupabaseClient } from "@supabase/supabase-js"

export const HUBTEL_USSD_CONFIG_KEY = "hubtel_ussd_config"

export interface HubtelUssdConfig {
  enabled: boolean
  mode: "main" | "shop"
  visibility: { data: boolean; afa: boolean; airtime: boolean; resultsChecker: boolean }
  /** First line of the main menu (main mode) and of the shop-code prompt (shop mode). */
  welcome: string
}

export const DEFAULT_WELCOME = "Welcome to Clingshub"
export const WELCOME_MAX = 60

const DEFAULT_CONFIG: HubtelUssdConfig = {
  enabled: false,
  mode: "main",
  visibility: { data: true, afa: true, airtime: true, resultsChecker: true },
  welcome: DEFAULT_WELCOME,
}

/**
 * The ONE rule for the welcome line (lib reads + admin route + admin page mirror it): a string,
 * trimmed, 1-60 chars, a single line, printable ASCII only (Hubtel rejects special characters
 * such as accents, emoji and curly quotes). Rejects rather than strips, so the admin sees why.
 * Empty-after-trim is an error here; the admin route treats it as "reset to default".
 */
export function validateWelcome(input: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "Welcome message must be a string" }
  const value = input.trim()
  if (value.length === 0) return { ok: false, error: "Welcome message is empty" }
  if (/[\r\n]/.test(value)) return { ok: false, error: "Welcome message must be a single line (no line breaks)" }
  const bad = Array.from(value).find(ch => !/^[\x20-\x7E]$/.test(ch))
  if (bad !== undefined) {
    const cp = bad.codePointAt(0)!
    const hex = cp.toString(16).toUpperCase().padStart(4, "0")
    // Control characters (tab, DEL...) are invisible: show only the code point.
    const shown = cp < 0x20 || cp === 0x7f ? `U+${hex}` : `"${bad}" (U+${hex})`
    return { ok: false, error: `Welcome message has a special character ${shown}: only plain letters, numbers, spaces and basic punctuation are allowed` }
  }
  if (value.length > WELCOME_MAX) return { ok: false, error: `Welcome message must be at most ${WELCOME_MAX} characters (got ${value.length})` }
  return { ok: true, value }
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
    // A missing or invalid stored value (hand-edited row, older rules) falls back to the default.
    welcome: storedWelcome(stored.welcome),
  }
}

function storedWelcome(raw: unknown): string {
  const v = validateWelcome(raw)
  return v.ok ? v.value : DEFAULT_WELCOME
}

export async function setHubtelUssdConfig(
  supabase: SupabaseClient,
  patch: {
    enabled?: boolean
    mode?: "main" | "shop"
    visibility?: Partial<HubtelUssdConfig["visibility"]>
    welcome?: string
  }
): Promise<HubtelUssdConfig> {
  if (patch.mode !== undefined && patch.mode !== "main" && patch.mode !== "shop") {
    throw new Error("invalid mode")
  }
  let welcome: string | undefined
  if (patch.welcome !== undefined) {
    const v = validateWelcome(patch.welcome)
    if (!v.ok) throw new Error(`invalid welcome: ${v.error}`)
    welcome = v.value
  }
  const current = await getHubtelUssdConfig(supabase)
  const next: HubtelUssdConfig = {
    enabled: patch.enabled ?? current.enabled,
    mode: patch.mode ?? current.mode,
    visibility: { ...current.visibility, ...(patch.visibility ?? {}) },
    welcome: welcome ?? current.welcome,
  }
  const { error } = await supabase.from("admin_settings").upsert(
    {
      key: HUBTEL_USSD_CONFIG_KEY,
      value: next,
      description: "Hubtel USSD channel: kill switch, main/shop mode, per-service visibility, welcome line.",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  )
  if (error) throw error
  return next
}
