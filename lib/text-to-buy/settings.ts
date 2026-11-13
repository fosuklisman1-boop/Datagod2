import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Text-to-Buy settings loader. Server-only. Never logs setting values.
 * Any read failure returns the defaults, and the defaults are OFF: the feature fails closed.
 */

export type TtbSettings = {
  mainEnabled: boolean
  mainNumber: string
  replySenderId: string
  aiEnabled: boolean
  staleMinutes: number
  promptsPerHour: number
  repliesPerHour: number
  aiReadsPerHour: number
  globalPromptsPerMinute: number
  promptWindowMinutes: number
  quietAlertMinutes: number
  retentionDays: number
  /** "defaults" when the DB read failed or threw, so callers can tell fallback values from saved ones. */
  source: "db" | "defaults"
}

export type TtbSettingField = Exclude<keyof TtbSettings, "source">

/** The ONE mapping from a settings field to its admin_settings key (each stored as { "value": x }). */
export const TTB_SETTING_KEYS = {
  mainEnabled: "ttb_main_enabled",
  mainNumber: "ttb_main_number",
  replySenderId: "ttb_reply_sender_id",
  aiEnabled: "ttb_ai_enabled",
  staleMinutes: "ttb_stale_minutes",
  promptsPerHour: "ttb_prompts_per_hour",
  repliesPerHour: "ttb_replies_per_hour",
  aiReadsPerHour: "ttb_ai_reads_per_hour",
  globalPromptsPerMinute: "ttb_global_prompts_per_minute",
  promptWindowMinutes: "ttb_prompt_window_minutes",
  quietAlertMinutes: "ttb_quiet_alert_minutes",
  retentionDays: "ttb_retention_days",
} as const satisfies Record<TtbSettingField, string>

export type TtbSettingKey = (typeof TTB_SETTING_KEYS)[TtbSettingField]

const KEYS: readonly TtbSettingKey[] = Object.values(TTB_SETTING_KEYS)

export const TTB_DEFAULTS: TtbSettings = {
  mainEnabled: false,
  mainNumber: "",
  replySenderId: "",
  aiEnabled: true,
  staleMinutes: 10,
  promptsPerHour: 3,
  repliesPerHour: 6,
  aiReadsPerHour: 10,
  globalPromptsPerMinute: 30,
  promptWindowMinutes: 5,
  quietAlertMinutes: 60,
  retentionDays: 30,
  source: "defaults",
}

/** min 0 is for the hourly caps (0 fails closed); minutes and days use min 1 (0 would purge everything or switch a protection off). */
function limit(x: unknown, fallback: number, min = 0): number {
  return typeof x === "number" && Number.isFinite(x) && x >= min ? x : fallback
}

function text(x: unknown, fallback: string): string {
  return typeof x === "string" ? x : fallback
}

export async function loadTtbSettings(db: SupabaseClient): Promise<TtbSettings> {
  try {
    const { data, error } = await db.from("admin_settings").select("key, value").in("key", [...KEYS])
    if (error || !Array.isArray(data)) return { ...TTB_DEFAULTS }

    const raw: Record<string, unknown> = {}
    for (const row of data as { key: string; value: unknown }[]) {
      const val = row?.value
      raw[row?.key] = val && typeof val === "object" && !Array.isArray(val) ? (val as { value?: unknown }).value : undefined
    }

    const d = TTB_DEFAULTS
    return {
      mainEnabled: raw.ttb_main_enabled === true,
      mainNumber: text(raw.ttb_main_number, d.mainNumber),
      replySenderId: text(raw.ttb_reply_sender_id, d.replySenderId),
      aiEnabled: typeof raw.ttb_ai_enabled === "boolean" ? raw.ttb_ai_enabled : d.aiEnabled,
      staleMinutes: limit(raw.ttb_stale_minutes, d.staleMinutes, 1),
      promptsPerHour: limit(raw.ttb_prompts_per_hour, d.promptsPerHour),
      repliesPerHour: limit(raw.ttb_replies_per_hour, d.repliesPerHour),
      aiReadsPerHour: limit(raw.ttb_ai_reads_per_hour, d.aiReadsPerHour),
      globalPromptsPerMinute: limit(raw.ttb_global_prompts_per_minute, d.globalPromptsPerMinute),
      promptWindowMinutes: limit(raw.ttb_prompt_window_minutes, d.promptWindowMinutes, 1),
      quietAlertMinutes: limit(raw.ttb_quiet_alert_minutes, d.quietAlertMinutes, 1),
      retentionDays: limit(raw.ttb_retention_days, d.retentionDays, 1),
      source: "db",
    }
  } catch {
    return { ...TTB_DEFAULTS }
  }
}
