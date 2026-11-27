/**
 * Admin settings for phone-number login (two admin_settings rows, one per key).
 * `value` is JSONB. Fails closed: any read error or malformed value resolves to
 * defaults, and `enabled` defaults to false (feature off).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"

export const PHONE_LOGIN_ENABLED_KEY = "phone_login_enabled"
export const PHONE_LOGIN_NEW_DEVICE_CODE_KEY = "phone_login_new_device_code"

export type PhoneLoginSettings = { enabled: boolean; newDeviceCode: boolean }

export const DEFAULT_PHONE_LOGIN_SETTINGS: PhoneLoginSettings = { enabled: false, newDeviceCode: true }

const KEYS = [PHONE_LOGIN_ENABLED_KEY, PHONE_LOGIN_NEW_DEVICE_CODE_KEY] as const

/** Accepts a JSON boolean or the strings "true"/"false"; anything else gives the default. */
function parseFlag(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v
  if (v === "true") return true
  if (v === "false") return false
  return fallback
}

/** `raw` is a map of key -> stored value, as produced by the DB loader. */
export function parsePhoneLoginSettings(raw: unknown): PhoneLoginSettings {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  return {
    enabled: parseFlag(v[PHONE_LOGIN_ENABLED_KEY], DEFAULT_PHONE_LOGIN_SETTINGS.enabled),
    newDeviceCode: parseFlag(v[PHONE_LOGIN_NEW_DEVICE_CODE_KEY], DEFAULT_PHONE_LOGIN_SETTINGS.newDeviceCode),
  }
}

const MEMO_MS = 30_000
let memo: { at: number; value: PhoneLoginSettings } | null = null

export function _resetPhoneLoginSettingsMemo(): void {
  memo = null
}

type SettingsClient = Pick<SupabaseClient, "from">

async function loadFromDb(client: SettingsClient = supabaseAdmin): Promise<Record<string, unknown>> {
  const { data, error } = await client.from("admin_settings").select("key, value").in("key", [...KEYS])
  if (error) throw error
  const out: Record<string, unknown> = {}
  for (const row of (data ?? []) as Array<{ key: string; value: unknown }>) {
    out[row.key] = row.value
  }
  return out
}

/**
 * Uncached read that THROWS on a DB error (missing rows give defaults).
 * For admin routes, where a failed read must never look like "defaults" -
 * otherwise a POST would overwrite stored settings with defaults.
 */
export async function getPhoneLoginSettingsStrict(client?: SettingsClient): Promise<PhoneLoginSettings> {
  return parsePhoneLoginSettings(await loadFromDb(client))
}

/** `load` is injectable for tests; production callers omit it. */
export async function getPhoneLoginSettings(
  opts: { fresh?: boolean; load?: () => Promise<unknown> } = {}
): Promise<PhoneLoginSettings> {
  const now = Date.now()
  if (!opts.fresh && memo && now - memo.at < MEMO_MS) return memo.value
  let value: PhoneLoginSettings
  try {
    value = parsePhoneLoginSettings(await (opts.load ?? loadFromDb)())
  } catch {
    value = DEFAULT_PHONE_LOGIN_SETTINGS
  }
  memo = { at: now, value }
  return value
}

/** Upserts both rows as JSON booleans. Throws on error. Clears the memo. */
export async function setPhoneLoginSettings(client: SettingsClient, next: PhoneLoginSettings): Promise<void> {
  const { error } = await client.from("admin_settings").upsert(
    [
      { key: PHONE_LOGIN_ENABLED_KEY, value: next.enabled },
      { key: PHONE_LOGIN_NEW_DEVICE_CODE_KEY, value: next.newDeviceCode },
    ],
    { onConflict: "key" }
  )
  if (error) throw error
  memo = null
}
