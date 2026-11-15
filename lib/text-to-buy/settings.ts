import type { SupabaseClient } from "@supabase/supabase-js"
import type { Line } from "./types"

/**
 * Text-to-Buy settings loader. Server-only. Never logs setting values.
 * Any read failure returns the defaults, and the defaults are OFF: the feature fails closed.
 */

export type ReplyTransport = "hubtel" | "sim"

export type TtbSettings = {
  mainEnabled: boolean
  mainNumber: string
  replySenderId: string
  /** Sender ID for replies on the shop line. Empty means the platform default. */
  shopReplySenderId: string
  aiEnabled: boolean
  staleMinutes: number
  promptsPerHour: number
  repliesPerHour: number
  aiReadsPerHour: number
  globalPromptsPerMinute: number
  promptWindowMinutes: number
  quietAlertMinutes: number
  retentionDays: number
  /** When false, a text that is not an order gets no reply (no SMS spend on unrelated or promotional texts). */
  unclearRepliesEnabled: boolean
  /** Replies per hour across ALL senders of a line. At the cap, everything except the order quote goes silent. */
  globalRepliesPerHour: number
  /** Customers may buy airtime by text. Off by default; per-network switches and fees still apply. */
  airtimeEnabled: boolean
  /** Customers may buy results checkers by text. Off by default; per-board switches and stock still apply. */
  resultsCheckerEnabled: boolean
  /** The shop line (orders for a shop's customers by text). Off by default. */
  shopEnabled: boolean
  /** The shop line's number, local 0XXXXXXXXX. Blank until set. */
  shopNumber: string
  /** Replies per hour to one shop's customers on the shop line. */
  shopRepliesPerHourPerShop: number
  /** Missed-call support SMS: a call to a line gets a how-to-order text back. Off by default. */
  callsEnabled: boolean
  /** Call-triggered texts per hour per line. */
  callsPerHourPerLine: number
  /** How replies on each line are sent: "hubtel" (default) or "sim" (the forwarder phone's own SIM, Hubtel as fallback). */
  replyTransportMain: ReplyTransport
  replyTransportShop: ReplyTransport
  /** Which SIM slot (1 or 2) carries each line's replies. */
  simSlotMain: 1 | 2
  simSlotShop: 1 | 2
  /** Rolling cap of SIM replies per line per 30 minutes (Android blocks apps that send more than ~30). */
  simMaxPer30Min: number
  /** "defaults" when the DB read failed or threw, so callers can tell fallback values from saved ones. */
  source: "db" | "defaults"
}

export type TtbSettingField = Exclude<keyof TtbSettings, "source">

/** The ONE mapping from a settings field to its admin_settings key (each stored as { "value": x }). */
export const TTB_SETTING_KEYS = {
  mainEnabled: "ttb_main_enabled",
  mainNumber: "ttb_main_number",
  replySenderId: "ttb_reply_sender_id",
  shopReplySenderId: "ttb_shop_reply_sender_id",
  aiEnabled: "ttb_ai_enabled",
  staleMinutes: "ttb_stale_minutes",
  promptsPerHour: "ttb_prompts_per_hour",
  repliesPerHour: "ttb_replies_per_hour",
  aiReadsPerHour: "ttb_ai_reads_per_hour",
  globalPromptsPerMinute: "ttb_global_prompts_per_minute",
  promptWindowMinutes: "ttb_prompt_window_minutes",
  quietAlertMinutes: "ttb_quiet_alert_minutes",
  retentionDays: "ttb_retention_days",
  unclearRepliesEnabled: "ttb_reply_to_unclear",
  globalRepliesPerHour: "ttb_global_replies_per_hour",
  airtimeEnabled: "ttb_airtime_enabled",
  resultsCheckerEnabled: "ttb_results_checker_enabled",
  shopEnabled: "ttb_shop_enabled",
  shopNumber: "ttb_shop_number",
  shopRepliesPerHourPerShop: "ttb_shop_replies_per_hour_per_shop",
  callsEnabled: "ttb_calls_enabled",
  callsPerHourPerLine: "ttb_calls_per_hour_per_line",
  replyTransportMain: "ttb_reply_transport_main",
  replyTransportShop: "ttb_reply_transport_shop",
  simSlotMain: "ttb_sim_slot_main",
  simSlotShop: "ttb_sim_slot_shop",
  simMaxPer30Min: "ttb_sim_max_per_30min",
} as const satisfies Record<TtbSettingField, string>

export type TtbSettingKey = (typeof TTB_SETTING_KEYS)[TtbSettingField]

const KEYS: readonly TtbSettingKey[] = Object.values(TTB_SETTING_KEYS)

export const TTB_DEFAULTS: TtbSettings = {
  mainEnabled: false,
  mainNumber: "",
  replySenderId: "",
  shopReplySenderId: "",
  aiEnabled: true,
  staleMinutes: 10,
  promptsPerHour: 3,
  repliesPerHour: 6,
  aiReadsPerHour: 10,
  globalPromptsPerMinute: 30,
  promptWindowMinutes: 5,
  quietAlertMinutes: 60,
  retentionDays: 30,
  unclearRepliesEnabled: true,
  globalRepliesPerHour: 300,
  airtimeEnabled: false,
  resultsCheckerEnabled: false,
  shopEnabled: false,
  shopNumber: "",
  shopRepliesPerHourPerShop: 60,
  callsEnabled: false,
  callsPerHourPerLine: 60,
  replyTransportMain: "hubtel",
  replyTransportShop: "hubtel",
  simSlotMain: 2,
  simSlotShop: 1,
  simMaxPer30Min: 20,
  source: "defaults",
}

/** Whether the named line's master switch is on. */
export function lineEnabled(s: TtbSettings, line: Line): boolean {
  return line === "shop" ? s.shopEnabled : s.mainEnabled
}

/** min 0 is for the hourly caps (0 fails closed); minutes and days use min 1 (0 would purge everything or switch a protection off). */
function limit(x: unknown, fallback: number, min = 0): number {
  return typeof x === "number" && Number.isFinite(x) && x >= min ? x : fallback
}

/** A whole number inside the admin range; anything else (wrong type, fraction, out of range) keeps the default. */
function intIn(x: unknown, fallback: number, min: number, max: number): number {
  return typeof x === "number" && Number.isInteger(x) && x >= min && x <= max ? x : fallback
}

function transport(x: unknown): ReplyTransport {
  return x === "sim" ? "sim" : "hubtel"
}

function slot(x: unknown, fallback: 1 | 2): 1 | 2 {
  return x === 1 || x === 2 ? x : fallback
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
      shopReplySenderId: text(raw.ttb_shop_reply_sender_id, d.shopReplySenderId),
      aiEnabled: typeof raw.ttb_ai_enabled === "boolean" ? raw.ttb_ai_enabled : d.aiEnabled,
      staleMinutes: limit(raw.ttb_stale_minutes, d.staleMinutes, 1),
      promptsPerHour: limit(raw.ttb_prompts_per_hour, d.promptsPerHour),
      repliesPerHour: limit(raw.ttb_replies_per_hour, d.repliesPerHour),
      aiReadsPerHour: limit(raw.ttb_ai_reads_per_hour, d.aiReadsPerHour),
      globalPromptsPerMinute: limit(raw.ttb_global_prompts_per_minute, d.globalPromptsPerMinute),
      promptWindowMinutes: limit(raw.ttb_prompt_window_minutes, d.promptWindowMinutes, 1),
      quietAlertMinutes: limit(raw.ttb_quiet_alert_minutes, d.quietAlertMinutes, 1),
      retentionDays: limit(raw.ttb_retention_days, d.retentionDays, 1),
      unclearRepliesEnabled: typeof raw.ttb_reply_to_unclear === "boolean" ? raw.ttb_reply_to_unclear : d.unclearRepliesEnabled,
      globalRepliesPerHour: intIn(raw.ttb_global_replies_per_hour, d.globalRepliesPerHour, 10, 5000),
      airtimeEnabled: raw.ttb_airtime_enabled === true,
      resultsCheckerEnabled: raw.ttb_results_checker_enabled === true,
      shopEnabled: raw.ttb_shop_enabled === true,
      shopNumber: text(raw.ttb_shop_number, d.shopNumber),
      shopRepliesPerHourPerShop: intIn(raw.ttb_shop_replies_per_hour_per_shop, d.shopRepliesPerHourPerShop, 5, 1000),
      callsEnabled: raw.ttb_calls_enabled === true,
      callsPerHourPerLine: intIn(raw.ttb_calls_per_hour_per_line, d.callsPerHourPerLine, 5, 500),
      replyTransportMain: transport(raw.ttb_reply_transport_main),
      replyTransportShop: transport(raw.ttb_reply_transport_shop),
      simSlotMain: slot(raw.ttb_sim_slot_main, d.simSlotMain),
      simSlotShop: slot(raw.ttb_sim_slot_shop, d.simSlotShop),
      simMaxPer30Min: intIn(raw.ttb_sim_max_per_30min, d.simMaxPer30Min, 1, 30),
      source: "db",
    }
  } catch {
    return { ...TTB_DEFAULTS }
  }
}
