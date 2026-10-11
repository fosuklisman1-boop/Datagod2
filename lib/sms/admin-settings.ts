/**
 * Admin SMS settings (Phase 2 spec §4.3): one SECTION per save, validated server-side with the same
 * ranges Phase 1's parseSmsSettings enforces, written to tenant_global_settings, audited (old/new)
 * and the 60 s settings cache invalidated. sms_policy_enforced is deliberately NOT writable here.
 */
import { createClient } from "@supabase/supabase-js"
import { writeAuditLog } from "./moderation-service"
import { invalidateSmsSettingsCache, normalizeDomain, parseSmsSettings, SMS_SETTING_KEYS, type SmsPlatformSettings } from "./platform-settings"
import { validateSenderName } from "./sender-name"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export const ALLOWED_ROLES = ["shop_owner", "sub_agent", "dealer", "user"] as const
const MAX_LIST = 500
const MAX_KEYWORD = 60

type Row = { key: string; value: unknown }
export type ValidationResult = { ok: true; rows: Row[] } | { ok: false; error: string }

const fail = (error: string): ValidationResult => ({ ok: false, error })
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max
const isNum = (v: unknown, min: number, max: number, minExclusive = false): v is number =>
  typeof v === "number" && Number.isFinite(v) && (minExclusive ? v > min : v >= min) && v <= max

function cleanKeywords(raw: unknown, label: string): { ok: true; list: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: `${label} must be a list` }
  const seen = new Set<string>(); const list: string[] = []
  for (const item of raw) {
    if (typeof item !== "string") return { ok: false, error: `${label} must contain text only` }
    const t = item.trim()
    if (!t) continue
    if (t.length > MAX_KEYWORD) return { ok: false, error: `${label}: "${t.slice(0, 20)}…" is longer than ${MAX_KEYWORD} characters` }
    if (seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase()); list.push(t)
  }
  if (list.length > MAX_LIST) return { ok: false, error: `${label} can hold at most ${MAX_LIST} entries` }
  return { ok: true, list }
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/

function validateCaps(v: unknown): ValidationResult {
  if (!isObj(v)) return fail("caps must be an object")
  const out: Record<string, { per_send: number; per_hour: number; per_day: number }> = {}
  for (const mode of ["platform", "business"] as const) {
    const m = v[mode]
    if (!isObj(m)) return fail(`caps.${mode} is required`)
    if (!isInt(m.per_send, 1, 1_000_000)) return fail(`${mode}: recipients per send must be a whole number from 1 to 1,000,000`)
    if (!isInt(m.per_hour, 1, 1_000_000)) return fail(`${mode}: sends per hour must be a whole number from 1 to 1,000,000`)
    if (!isInt(m.per_day, 1, 100_000_000)) return fail(`${mode}: recipients per day must be a whole number from 1 to 100,000,000`)
    out[mode] = { per_send: m.per_send, per_hour: m.per_hour, per_day: m.per_day }
  }
  return { ok: true, rows: [{ key: "sms_caps", value: out }] }
}

export function validateSection(section: string, values: unknown): ValidationResult {
  if (!isObj(values)) return fail("Invalid values")
  switch (section) {
    case "switch":
      return typeof values.featureEnabled === "boolean" ? { ok: true, rows: [{ key: "sms_feature_enabled", value: values.featureEnabled }] } : fail("featureEnabled must be true or false")
    case "caps":
      return validateCaps(values)
    case "moderation":
      if (!isInt(values.autoSuspendFlags, 1, 100)) return fail("Auto-suspend threshold must be a whole number from 1 to 100")
      if (!isInt(values.flagReviewThreshold, 1, 500)) return fail("Flag-review threshold must be a whole number from 1 to 500")
      return { ok: true, rows: [{ key: "sms_auto_suspend_flags", value: values.autoSuspendFlags }, { key: "sms_flag_review_threshold", value: values.flagReviewThreshold }] }
    case "api_limit":
      return isInt(values.apiRateLimitDefault, 1, 10_000) ? { ok: true, rows: [{ key: "sms_api_rate_limit_default", value: values.apiRateLimitDefault }] } : fail("API rate limit must be a whole number from 1 to 10,000")
    case "roles": {
      if (!Array.isArray(values.allowedRoles)) return fail("allowedRoles must be a list")
      const roles = [...new Set(values.allowedRoles)]
      if (!roles.every((r) => typeof r === "string" && (ALLOWED_ROLES as readonly string[]).includes(r))) return fail(`Roles must be among: ${ALLOWED_ROLES.join(", ")}`)
      return { ok: true, rows: [{ key: "sms_allowed_roles", value: roles }] }
    }
    case "sender_pool": {
      if (!Array.isArray(values.senderPool)) return fail("senderPool must be a list")
      const names: string[] = []
      for (const raw of values.senderPool) {
        if (typeof raw !== "string") return fail("Sender names must be text")
        const c = validateSenderName(raw, [])
        if (!c.ok) return fail(`"${raw}": ${c.reason}`)
        if (!names.includes(c.name)) names.push(c.name)
      }
      if (names.length > 200) return fail("The sender pool can hold at most 200 names")
      return { ok: true, rows: [{ key: "sms_sender_pool", value: names }] }
    }
    case "platform_keywords": {
      const k = cleanKeywords(values.blockedKeywords, "Blocked keywords")
      return k.ok ? { ok: true, rows: [{ key: "sms_blocked_keywords", value: k.list }] } : fail(k.error)
    }
    case "business_lists": {
      const blocked = cleanKeywords(values.businessBlockedKeywords, "Business blocked keywords")
      if (!blocked.ok) return fail(blocked.error)
      const flagged = cleanKeywords(values.businessFlaggedKeywords, "Business flagged keywords")
      if (!flagged.ok) return fail(flagged.error)
      if (!Array.isArray(values.businessAllowedDomains)) return fail("businessAllowedDomains must be a list")
      const domains: string[] = []
      for (const raw of values.businessAllowedDomains) {
        if (typeof raw !== "string") return fail("Domains must be text")
        if (!raw.trim()) continue
        const d = normalizeDomain(raw)
        if (!DOMAIN_RE.test(d)) return fail(`"${raw}" is not a valid domain`)
        if (!domains.includes(d)) domains.push(d)
      }
      if (domains.length > MAX_LIST) return fail(`Allowed domains can hold at most ${MAX_LIST} entries`)
      return { ok: true, rows: [
        { key: "sms_business_blocked_keywords", value: blocked.list },
        { key: "sms_business_flagged_keywords", value: flagged.list },
        { key: "sms_business_allowed_domains", value: domains },
      ] }
    }
    case "pricing":
      if (!isNum(values.activationFee, 0, 10_000)) return fail("Activation fee must be between 0 and 10,000")
      if (!isInt(values.welcomeBonusCredits, 1, 100_000)) return fail("Welcome bonus must be a whole number from 1 to 100,000")
      if (!isNum(values.pricePerCredit, 0.001, 100)) return fail("Price per credit must be between 0.001 and 100")
      return { ok: true, rows: [
        { key: "sms_activation_fee", value: { amount: Math.round(values.activationFee * 100) / 100 } },
        { key: "sms_welcome_bonus_credits", value: { units: values.welcomeBonusCredits } },
        { key: "sms_price_per_credit", value: { amount: values.pricePerCredit } },
      ] }
    case "hubtel":
      if (!isNum(values.hubtelCostPerSms, 0.0001, 10)) return fail("Hubtel cost per SMS must be between 0.0001 and 10")
      if (!isNum(values.hubtelLowBalanceGhs, 0, 1_000_000)) return fail("Low-balance alert must be between 0 and 1,000,000")
      return { ok: true, rows: [{ key: "sms_hubtel_cost_per_sms", value: values.hubtelCostPerSms }, { key: "sms_hubtel_low_balance_ghs", value: values.hubtelLowBalanceGhs }] }
    default:
      return fail("Unknown settings section")
  }
}

export type SaveResult = { ok: true; updated: string[] } | { ok: false; error: string }

export async function saveSection(adminId: string, section: string, values: unknown): Promise<SaveResult> {
  if (!adminId) return { ok: false, error: "Admin user required" }
  const v = validateSection(section, values)
  if (!v.ok) return { ok: false, error: v.error }
  const keys = v.rows.map((r) => r.key)

  const { data: oldRows, error: readError } = await supabaseAdmin.from("tenant_global_settings").select("key, value").in("key", keys)
  if (readError) {
    console.error("[SMS-ADMIN] settings read failed:", readError.message)
    return { ok: false, error: "Could not read the current settings" }
  }
  const oldValues = Object.fromEntries(((oldRows ?? []) as Row[]).map((r) => [r.key, r.value]))

  const { error } = await supabaseAdmin.from("tenant_global_settings").upsert(v.rows, { onConflict: "key" })
  if (error) {
    console.error("[SMS-ADMIN] settings save failed:", error.message)
    return { ok: false, error: "Could not save settings" }
  }
  await writeAuditLog(
    adminId, "sms_settings_update", null,
    { section, values: oldValues },
    { section, values: Object.fromEntries(v.rows.map((r) => [r.key, r.value])) }
  ).catch((e) => console.error("[SMS-ADMIN] audit failed:", e))
  invalidateSmsSettingsCache()
  return { ok: true, updated: keys }
}

export interface Pricing { activationFee: number; welcomeBonusCredits: number; pricePerCredit: number }

export function parsePricing(rows: Row[]): Pricing {
  const m = new Map(rows.map((r) => [r.key, r.value]))
  const pick = (key: string, field: string, d: number) => {
    const v = m.get(key)
    const n = isObj(v) ? Number(v[field]) : typeof v === "number" ? v : NaN
    return Number.isFinite(n) ? n : d
  }
  return {
    activationFee: pick("sms_activation_fee", "amount", 0),
    welcomeBonusCredits: pick("sms_welcome_bonus_credits", "units", 0),
    pricePerCredit: pick("sms_price_per_credit", "amount", 0.04),
  }
}

export interface AdminSettings { settings: SmsPlatformSettings; pricing: Pricing }

/** Fresh, uncached, fail-loud read: a failed read must not show defaults as if they were saved. */
export async function getAdminSettings(): Promise<AdminSettings> {
  const { data, error } = await supabaseAdmin.from("tenant_global_settings").select("key, value")
    .in("key", [...SMS_SETTING_KEYS, "sms_activation_fee", "sms_welcome_bonus_credits", "sms_price_per_credit"])
  if (error) throw new Error(`settings read failed: ${error.message}`)
  const rows = (data ?? []) as Row[]
  return { settings: parseSmsSettings(rows), pricing: parsePricing(rows) }
}
