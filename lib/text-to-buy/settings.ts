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

const KEYS = [
  "ttb_main_enabled",
  "ttb_main_number",
  "ttb_reply_sender_id",
  "ttb_ai_enabled",
  "ttb_stale_minutes",
  "ttb_prompts_per_hour",
  "ttb_replies_per_hour",
  "ttb_ai_reads_per_hour",
  "ttb_global_prompts_per_minute",
  "ttb_prompt_window_minutes",
  "ttb_quiet_alert_minutes",
  "ttb_retention_days",
] as const

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

function limit(x: unknown, fallback: number): number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : fallback
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
      staleMinutes: limit(raw.ttb_stale_minutes, d.staleMinutes),
      promptsPerHour: limit(raw.ttb_prompts_per_hour, d.promptsPerHour),
      repliesPerHour: limit(raw.ttb_replies_per_hour, d.repliesPerHour),
      aiReadsPerHour: limit(raw.ttb_ai_reads_per_hour, d.aiReadsPerHour),
      globalPromptsPerMinute: limit(raw.ttb_global_prompts_per_minute, d.globalPromptsPerMinute),
      promptWindowMinutes: limit(raw.ttb_prompt_window_minutes, d.promptWindowMinutes),
      quietAlertMinutes: limit(raw.ttb_quiet_alert_minutes, d.quietAlertMinutes),
      retentionDays: limit(raw.ttb_retention_days, d.retentionDays),
      source: "db",
    }
  } catch {
    return { ...TTB_DEFAULTS }
  }
}
