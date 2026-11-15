/**
 * Admin settings for blocked MTN number tracking (admin_settings key below).
 * Fails safe: any read error or malformed value resolves to defaults (feature off).
 */

import { supabaseAdmin } from "@/lib/supabase"

export const BLOCKED_SETTINGS_KEY = "blocked_numbers_settings"

export type BlockedNumbersSettings = {
  enabled: boolean
  customer_sms_enabled: boolean
  retention_days: number
  spike_threshold_per_hour: number
  daily_sms_ceiling: number
}

export const DEFAULT_BLOCKED_SETTINGS: BlockedNumbersSettings = {
  enabled: false,
  customer_sms_enabled: false,
  retention_days: 30,
  spike_threshold_per_hour: 25,
  daily_sms_ceiling: 300,
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.floor(v)))
}

export function parseBlockedSettings(raw: unknown): BlockedNumbersSettings {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const d = DEFAULT_BLOCKED_SETTINGS
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : d.enabled,
    customer_sms_enabled: typeof v.customer_sms_enabled === "boolean" ? v.customer_sms_enabled : d.customer_sms_enabled,
    retention_days: clampInt(v.retention_days, 1, 365, d.retention_days),
    spike_threshold_per_hour: clampInt(v.spike_threshold_per_hour, 1, 10000, d.spike_threshold_per_hour),
    daily_sms_ceiling: clampInt(v.daily_sms_ceiling, 0, 10000, d.daily_sms_ceiling),
  }
}

const MEMO_MS = 60_000
let memo: { at: number; value: BlockedNumbersSettings } | null = null

export function _resetSettingsMemo(): void {
  memo = null
}

async function loadFromDb(): Promise<unknown> {
  const { data, error } = await supabaseAdmin
    .from("admin_settings")
    .select("value")
    .eq("key", BLOCKED_SETTINGS_KEY)
    .maybeSingle()
  if (error) throw error
  return data?.value ?? null
}

/** `load` is injectable for tests; production callers omit it. */
export async function getBlockedNumbersSettings(
  opts: { fresh?: boolean; load?: () => Promise<unknown> } = {}
): Promise<BlockedNumbersSettings> {
  const now = Date.now()
  if (!opts.fresh && memo && now - memo.at < MEMO_MS) return memo.value
  let value: BlockedNumbersSettings
  try {
    value = parseBlockedSettings(await (opts.load ?? loadFromDb)())
  } catch {
    value = DEFAULT_BLOCKED_SETTINGS
  }
  memo = { at: now, value }
  return value
}
