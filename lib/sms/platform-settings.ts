/**
 * SMS platform settings (spec §5.1 "Settings"), stored as jsonb rows in
 * tenant_global_settings. The parser is tolerant: older admin screens saved some keys as
 * objects ({enabled}, {value}) or comma strings, and a bad value must never break sending.
 */
import { createClient } from "@supabase/supabase-js"
import { parseHubtelManualBalance, type HubtelManualBalance } from "./hubtel-manual-balance"

export type SmsMode = "platform" | "business"
export interface ModeCaps { per_send: number; per_hour: number; per_day: number }

export interface SmsPlatformSettings {
  featureEnabled: boolean
  policyEnforced: boolean
  allowedRoles: string[]
  senderPool: string[]
  caps: Record<SmsMode, ModeCaps>
  blockedKeywords: string[]
  businessBlockedKeywords: string[]
  businessFlaggedKeywords: string[]
  businessAllowedDomains: string[]
  autoSuspendFlags: number
  flagReviewThreshold: number
  apiRateLimitDefault: number
  protectedSenderNames: string[]
  hubtelCostPerSms: number
  hubtelLowBalanceGhs: number
  /** Admin-managed platform sender names (Hubtel sends only). */
  platformSenders: string[]
  /** Must be one of platformSenders to take effect; null = use the env/hardcoded name. */
  platformDefaultSender: string | null
  /** Manual Hubtel balance fallback (used only while the relay /balance fails); null = none. */
  hubtelManualBalance: HubtelManualBalance | null
  /**
   * Use the manual balance even when the relay /balance works (the relay reads the Disbursement
   * wallet, not the SMS-API wallet Hubtel SMS is paid from). Default false.
   */
  hubtelPreferManualBalance: boolean
}

export const DEFAULT_SMS_SETTINGS: SmsPlatformSettings = {
  featureEnabled: true,
  policyEnforced: false,
  allowedRoles: ["shop_owner", "sub_agent"],
  senderPool: [],
  caps: {
    platform: { per_send: 300, per_hour: 20, per_day: 500 },
    business: { per_send: 1000, per_hour: 2000, per_day: 1_000_000 },
  },
  blockedKeywords: [],
  businessBlockedKeywords: [],
  businessFlaggedKeywords: [],
  businessAllowedDomains: [],
  autoSuspendFlags: 2,
  flagReviewThreshold: 5,
  apiRateLimitDefault: 30,
  // Mirrors the seed in migrations/20261010_sms_platform_foundation.sql.
  protectedSenderNames: [
    "MTN", "TELECEL", "VODAFONE", "AIRTELTIGO", "AIRTEL", "TIGO", "GLO", "MOMO", "MOBILEMONEY",
    "HUBTEL", "PAYSTACK", "EXPRESSPAY", "ZEEPAY", "GCB", "ECOBANK", "STANBIC", "ABSA", "FIDELITY",
    "CALBANK", "ZENITH", "ACCESSBANK", "GTBANK", "UBA", "SOCGEN", "REPUBLICBANK", "PRUDENTIAL",
    "ADB", "NIB", "CBG", "OMNIBSIC", "FIRSTBANK", "BANKOFGHANA", "BOG", "GRA", "ECG", "GWCL",
    "NHIS", "NIA", "DVLA", "GHANAPOST", "POLICE", "GHANAGOV", "WAEC", "DATAGOD",
  ],
  hubtelCostPerSms: 0.035,
  hubtelLowBalanceGhs: 50,
  platformSenders: [],
  platformDefaultSender: null,
  hubtelManualBalance: null,
  hubtelPreferManualBalance: false,
}

export const SMS_SETTING_KEYS = [
  "sms_feature_enabled", "sms_policy_enforced", "sms_allowed_roles", "sms_sender_pool", "sms_caps",
  "sms_blocked_keywords", "sms_business_blocked_keywords", "sms_business_flagged_keywords",
  "sms_business_allowed_domains", "sms_auto_suspend_flags", "sms_flag_review_threshold",
  "sms_api_rate_limit_default", "sms_protected_sender_names", "sms_hubtel_cost_per_sms",
  "sms_hubtel_low_balance_ghs", "sms_platform_senders", "sms_platform_default_sender",
  "sms_hubtel_manual_balance", "sms_hubtel_prefer_manual_balance",
] as const

/** Older admin screens wrapped values as {enabled}/{value}/{amount}; read only the keys that make sense for the target type. */
function unwrap(v: unknown, keys: string[]): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    for (const k of keys) if (k in o) return o[k]
  }
  return v
}
const bool = (v: unknown, d: boolean) => {
  const u = unwrap(v, ["enabled", "value"])
  if (typeof u === "boolean") return u
  if (typeof u === "string") {
    const t = u.trim().toLowerCase()
    if (t === "true") return true
    if (t === "false") return false
  }
  return d
}
const num = (v: unknown, d: number, min: number, max: number) => {
  const u = unwrap(v, ["value", "amount"])
  const n = typeof u === "number" ? u : typeof u === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(u) ? Number(u) : NaN
  return Number.isFinite(n) && n >= min && n <= max ? n : d
}
const int = (v: unknown, d: number, min: number, max: number) => {
  const n = num(v, d, min, max)
  return Number.isInteger(n) ? n : d
}
/** Explicit empty list stays empty; a non-empty raw value with no usable entries falls back to the default. Always returns a fresh array. */
function list(v: unknown, d: readonly string[]): string[] {
  const u = unwrap(v, ["value", "amount"])
  const raw = Array.isArray(u) ? u : typeof u === "string" ? u.split(",") : null
  if (!raw) return [...d]
  const out = raw.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
  if (out.length === 0 && raw.some((x) => !(typeof x === "string" && x.trim() === ""))) return [...d]
  return out
}
/** Blank / non-string -> null, else trimmed + upper-cased. */
function optName(v: unknown): string | null {
  const u = unwrap(v, ["value"])
  if (typeof u !== "string") return null
  const t = u.trim().toUpperCase()
  return t || null
}
function caps(v: unknown): Record<SmsMode, ModeCaps> {
  const d = DEFAULT_SMS_SETTINGS.caps
  const u = unwrap(v, ["value"])
  if (!u || typeof u !== "object" || Array.isArray(u)) return { platform: { ...d.platform }, business: { ...d.business } }
  const o = u as Record<string, Record<string, unknown> | undefined>
  const one = (m: SmsMode): ModeCaps => ({
    per_send: int(o[m]?.per_send, d[m].per_send, 1, 1_000_000),
    per_hour: int(o[m]?.per_hour, d[m].per_hour, 1, 1_000_000),
    per_day: int(o[m]?.per_day, d[m].per_day, 1, 100_000_000),
  })
  return { platform: one("platform"), business: one("business") }
}

/** "https://www.Bit.ly/x/" -> "bit.ly" */
export function normalizeDomain(s: string): string {
  return s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/\.+$/, "")
}

export function parseSmsSettings(rows: { key: string; value: unknown }[]): SmsPlatformSettings {
  const m = new Map(rows.map((r) => [r.key, r.value]))
  const d = DEFAULT_SMS_SETTINGS
  return {
    featureEnabled: bool(m.get("sms_feature_enabled"), d.featureEnabled),
    policyEnforced: bool(m.get("sms_policy_enforced"), d.policyEnforced),
    allowedRoles: list(m.get("sms_allowed_roles"), d.allowedRoles),
    senderPool: list(m.get("sms_sender_pool"), d.senderPool).map((s) => s.toUpperCase()),
    caps: caps(m.get("sms_caps")),
    blockedKeywords: list(m.get("sms_blocked_keywords"), d.blockedKeywords),
    businessBlockedKeywords: list(m.get("sms_business_blocked_keywords"), d.businessBlockedKeywords),
    businessFlaggedKeywords: list(m.get("sms_business_flagged_keywords"), d.businessFlaggedKeywords),
    businessAllowedDomains: list(m.get("sms_business_allowed_domains"), d.businessAllowedDomains).map(normalizeDomain).filter(Boolean),
    autoSuspendFlags: int(m.get("sms_auto_suspend_flags"), d.autoSuspendFlags, 1, 100),
    flagReviewThreshold: int(m.get("sms_flag_review_threshold"), d.flagReviewThreshold, 1, 500),
    apiRateLimitDefault: int(m.get("sms_api_rate_limit_default"), d.apiRateLimitDefault, 1, 10_000),
    protectedSenderNames: list(m.get("sms_protected_sender_names"), d.protectedSenderNames),
    hubtelCostPerSms: num(m.get("sms_hubtel_cost_per_sms"), d.hubtelCostPerSms, 0.0001, 10),
    hubtelLowBalanceGhs: num(m.get("sms_hubtel_low_balance_ghs"), d.hubtelLowBalanceGhs, 0, 1_000_000),
    platformSenders: list(m.get("sms_platform_senders"), d.platformSenders).map((s) => s.toUpperCase()),
    platformDefaultSender: optName(m.get("sms_platform_default_sender")),
    hubtelManualBalance: parseHubtelManualBalance(m.get("sms_hubtel_manual_balance")),
    hubtelPreferManualBalance: bool(m.get("sms_hubtel_prefer_manual_balance"), d.hubtelPreferManualBalance),
  }
}

/** Per-minute API limit for /api/v1/sms/send: account override, else the platform default. */
export function apiRateLimitFor(override: number | null | undefined, platformDefault: number): number {
  return typeof override === "number" && Number.isInteger(override) && override >= 1 && override <= 10_000
    ? override
    : platformDefault
}

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const CACHE_MS = 60_000
let cache: { at: number; value: SmsPlatformSettings } | null = null

/** Cached (60 s) settings. Falls back to defaults if the read fails — never throws. */
export async function loadSmsSettings(): Promise<SmsPlatformSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  const { data, error } = await supabaseAdmin
    .from("tenant_global_settings").select("key, value").in("key", [...SMS_SETTING_KEYS])
  if (error) {
    console.error("[SMS-SETTINGS] load failed, using defaults:", error.message)
    // Back off ~10s before retrying instead of hammering a failing DB on every send.
    cache = { at: Date.now() - CACHE_MS + 10_000, value: cache?.value ?? parseSmsSettings([]) }
    return cache.value
  }
  const value = parseSmsSettings((data ?? []) as { key: string; value: unknown }[])
  cache = { at: Date.now(), value }
  return value
}

export interface HubtelBalanceSettings {
  preferManual: boolean
  manual: HubtelManualBalance | null
  hubtelCostPerSms: number
}

const HUBTEL_BALANCE_KEYS = ["sms_hubtel_prefer_manual_balance", "sms_hubtel_manual_balance", "sms_hubtel_cost_per_sms"] as const

/**
 * STRICT, UNCACHED read of the settings that decide which Hubtel balance backs credit sales (money
 * path, Hubtel-primary only). Unlike loadSmsSettings — which falls back to cached values or defaults —
 * this THROWS on any DB error, a missing payload, or a prefer flag it can't read, so callers fail
 * closed instead of silently using the relay (Disbursement wallet) figure. No cache, so a toggle on
 * one instance is seen by every instance on the next check.
 */
export async function loadHubtelBalanceSettings(): Promise<HubtelBalanceSettings> {
  const { data, error } = await supabaseAdmin
    .from("tenant_global_settings").select("key, value").in("key", [...HUBTEL_BALANCE_KEYS])
  if (error) throw new Error(`Hubtel balance settings read failed: ${error.message}`)
  if (!Array.isArray(data)) throw new Error("Hubtel balance settings read returned no data")
  const rows = data as { key: string; value: unknown }[]
  const preferRow = rows.find((r) => r.key === "sms_hubtel_prefer_manual_balance")
  if (preferRow) {
    const u = unwrap(preferRow.value, ["enabled", "value"])
    if (typeof u !== "boolean") throw new Error(`unreadable sms_hubtel_prefer_manual_balance value: ${JSON.stringify(preferRow.value)}`)
  }
  const s = parseSmsSettings(rows)
  return { preferManual: s.hubtelPreferManualBalance, manual: s.hubtelManualBalance, hubtelCostPerSms: s.hubtelCostPerSms }
}

export function invalidateSmsSettingsCache(): void {
  cache = null
}
