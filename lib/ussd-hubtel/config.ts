// Single JSON blob in admin_settings (key/value convention — NOT the app_settings
// singleton row; see the app_settings table-collision incident). Caller owns the client.
import type { SupabaseClient } from "@supabase/supabase-js"

export const HUBTEL_USSD_CONFIG_KEY = "hubtel_ussd_config"

export interface HubtelUssdConfig {
  enabled: boolean
  mode: "main" | "shop"
  visibility: { data: boolean; afa: boolean; airtime: boolean; resultsChecker: boolean }
  /** Brand shown on Hubtel screens: derived welcome line, exit message, Check Results account message. */
  brandName: string
  /**
   * EFFECTIVE first line of the main menu (main mode) and of the shop-code prompt (shop mode):
   * the admin's custom welcome when set, else `Welcome to ${brandName}`.
   */
  welcome: string
  /** True when `welcome` is an admin override, false when it is derived from the brand. */
  welcomeCustom: boolean
}

/** What is persisted: the brand and, only when customised, the welcome override. */
interface StoredHubtelUssdConfig {
  enabled?: unknown
  mode?: unknown
  visibility?: Partial<HubtelUssdConfig["visibility"]>
  brandName?: unknown
  welcome?: unknown
}

export const DEFAULT_BRAND = "Clingshub"
export const BRAND_MAX = 30
export const WELCOME_MAX = 60

export function derivedWelcome(brandName: string): string {
  return `Welcome to ${brandName}`
}

/**
 * The derived welcome for the default brand. Also the literal the previous release stored as the
 * welcome: a stored welcome equal to it is treated as NOT custom, so a brand change re-derives it.
 */
export const DEFAULT_WELCOME = derivedWelcome(DEFAULT_BRAND)

const DEFAULT_VISIBILITY: HubtelUssdConfig["visibility"] = { data: true, afa: true, airtime: true, resultsChecker: true }

type Validation = { ok: true; value: string } | { ok: false; error: string }

/**
 * Shared rule for admin-entered screen text: a string, trimmed, 1-`max` chars, a single line,
 * printable ASCII only (Hubtel rejects special characters such as accents, emoji and curly
 * quotes). Rejects rather than strips, so the admin sees why. Empty-after-trim is an error here;
 * the admin route treats it as "reset to default".
 */
function validateScreenText(label: string, input: unknown, max: number): Validation {
  if (typeof input !== "string") return { ok: false, error: `${label} must be a string` }
  const value = input.trim()
  if (value.length === 0) return { ok: false, error: `${label} is empty` }
  if (/[\r\n]/.test(value)) return { ok: false, error: `${label} must be a single line (no line breaks)` }
  const bad = Array.from(value).find(ch => !/^[\x20-\x7E]$/.test(ch))
  if (bad !== undefined) {
    const cp = bad.codePointAt(0)!
    const hex = cp.toString(16).toUpperCase().padStart(4, "0")
    // Control characters (tab, DEL...) are invisible: show only the code point.
    const shown = cp < 0x20 || cp === 0x7f ? `U+${hex}` : `"${bad}" (U+${hex})`
    return { ok: false, error: `${label} has a special character ${shown}: only plain letters, numbers, spaces and basic punctuation are allowed` }
  }
  if (value.length > max) return { ok: false, error: `${label} must be at most ${max} characters (got ${value.length})` }
  return { ok: true, value }
}

/** Welcome line rule (lib reads + admin route + admin page): 1-60 printable ASCII chars, one line. */
export function validateWelcome(input: unknown): Validation {
  return validateScreenText("Welcome message", input, WELCOME_MAX)
}

/** Brand name rule (lib reads + admin route + admin page): 1-30 printable ASCII chars, one line. */
export function validateBrandName(input: unknown): Validation {
  return validateScreenText("Brand name", input, BRAND_MAX)
}

const REQUIRED_ENV = ["HUBTEL_WEBHOOK_SECRET", "HUBTEL_RELAY_URL", "HUBTEL_RELAY_SECRET"] as const

/** The channel may only be enabled when every Hubtel env var is set (empty counts as missing). */
export function hubtelEnvReady(
  env: Record<string, string | undefined> = process.env
): { ready: boolean; missing: string[] } {
  const missing = REQUIRED_ENV.filter(k => !env[k])
  return { ready: missing.length === 0, missing }
}

/** A valid stored brand, else the default. */
function storedBrand(raw: unknown): string {
  const v = validateBrandName(raw)
  return v.ok ? v.value : DEFAULT_BRAND
}

/** The stored welcome override, or null when absent, invalid, or the legacy default literal. */
function storedCustomWelcome(raw: unknown): string | null {
  const v = validateWelcome(raw)
  return v.ok && v.value !== DEFAULT_WELCOME ? v.value : null
}

function resolveConfig(stored: StoredHubtelUssdConfig): HubtelUssdConfig {
  const brandName = storedBrand(stored.brandName)
  const custom = storedCustomWelcome(stored.welcome)
  return {
    // Only an explicit `true` enables the channel.
    enabled: stored.enabled === true,
    mode: stored.mode === "shop" ? "shop" : "main",
    visibility: { ...DEFAULT_VISIBILITY, ...(stored.visibility ?? {}) },
    // Missing or invalid stored values (hand-edited row, older rules) fall back to the defaults.
    brandName,
    welcome: custom ?? derivedWelcome(brandName),
    welcomeCustom: custom !== null,
  }
}

export async function getHubtelUssdConfig(supabase: SupabaseClient): Promise<HubtelUssdConfig> {
  const { data, error } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", HUBTEL_USSD_CONFIG_KEY)
    .maybeSingle()
  if (error) throw error
  const stored = data?.value && typeof data.value === "object" ? (data.value as StoredHubtelUssdConfig) : {}
  return resolveConfig(stored)
}

export async function setHubtelUssdConfig(
  supabase: SupabaseClient,
  patch: {
    enabled?: boolean
    mode?: "main" | "shop"
    visibility?: Partial<HubtelUssdConfig["visibility"]>
    brandName?: string
    /** A string sets the custom welcome; null clears it (back to `Welcome to <brand>`). */
    welcome?: string | null
  }
): Promise<HubtelUssdConfig> {
  if (patch.mode !== undefined && patch.mode !== "main" && patch.mode !== "shop") {
    throw new Error("invalid mode")
  }
  let brandName: string | undefined
  if (patch.brandName !== undefined) {
    const v = validateBrandName(patch.brandName)
    if (!v.ok) throw new Error(`invalid brandName: ${v.error}`)
    brandName = v.value
  }
  let welcome: string | null | undefined
  if (patch.welcome === null) {
    welcome = null
  } else if (patch.welcome !== undefined) {
    const v = validateWelcome(patch.welcome)
    if (!v.ok) throw new Error(`invalid welcome: ${v.error}`)
    welcome = v.value
  }
  const current = await getHubtelUssdConfig(supabase)
  const custom = welcome !== undefined ? welcome : current.welcomeCustom ? current.welcome : null
  const stored: StoredHubtelUssdConfig = {
    enabled: patch.enabled ?? current.enabled,
    mode: patch.mode ?? current.mode,
    visibility: { ...current.visibility, ...(patch.visibility ?? {}) },
    brandName: brandName ?? current.brandName,
    // The derived welcome is never stored, so a later brand change re-derives it.
    ...(custom !== null ? { welcome: custom } : {}),
  }
  const { error } = await supabase.from("admin_settings").upsert(
    {
      key: HUBTEL_USSD_CONFIG_KEY,
      value: stored,
      description: "Hubtel USSD channel: kill switch, main/shop mode, per-service visibility, brand name, custom welcome line.",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  )
  if (error) throw error
  return resolveConfig(stored)
}
