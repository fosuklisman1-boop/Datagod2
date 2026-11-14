import { normalizeGhanaPhone } from "@/lib/phone-format"
import { TTB_SETTING_KEYS, type TtbSettingField, type TtbSettingKey } from "./settings"

// Pure validation for the Text-to-Buy admin API. No I/O. Never logs or echoes values: errors name the field only.

export type ValidationOutcome = { ok: true; patch: Partial<Record<TtbSettingKey, unknown>> } | { ok: false; error: string }

type Rule = { kind: "bool" } | { kind: "int"; min: number; max: number } | { kind: "phone" } | { kind: "senderId" }

const RULES: Record<TtbSettingField, Rule> = {
  mainEnabled: { kind: "bool" },
  mainNumber: { kind: "phone" },
  replySenderId: { kind: "senderId" },
  shopReplySenderId: { kind: "senderId" },
  aiEnabled: { kind: "bool" },
  staleMinutes: { kind: "int", min: 1, max: 120 },
  promptsPerHour: { kind: "int", min: 1, max: 20 },
  repliesPerHour: { kind: "int", min: 1, max: 30 },
  aiReadsPerHour: { kind: "int", min: 0, max: 60 },
  globalPromptsPerMinute: { kind: "int", min: 1, max: 500 },
  promptWindowMinutes: { kind: "int", min: 2, max: 30 },
  quietAlertMinutes: { kind: "int", min: 10, max: 1440 },
  retentionDays: { kind: "int", min: 1, max: 90 },
  unclearRepliesEnabled: { kind: "bool" },
  globalRepliesPerHour: { kind: "int", min: 10, max: 5000 },
  airtimeEnabled: { kind: "bool" },
  resultsCheckerEnabled: { kind: "bool" },
}

const SENDER_ID_RE = /^[A-Za-z0-9 ]{1,11}$/
const FIELDS = Object.keys(TTB_SETTING_KEYS) as TtbSettingField[]

/** A Ghana mobile number in any common form, as local 0XXXXXXXXX, or null. */
export function normaliseSender(x: unknown): string | null {
  return typeof x === "string" && x.length <= 20 ? normalizeGhanaPhone(x.trim()) : null
}

function check(rule: Rule, v: unknown): { ok: true; value: unknown } | { ok: false } {
  switch (rule.kind) {
    case "bool":
      return typeof v === "boolean" ? { ok: true, value: v } : { ok: false }
    case "int":
      return typeof v === "number" && Number.isInteger(v) && v >= rule.min && v <= rule.max ? { ok: true, value: v } : { ok: false }
    case "phone": {
      if (typeof v !== "string") return { ok: false }
      if (v.trim() === "") return { ok: true, value: "" }
      const n = normaliseSender(v)
      return n ? { ok: true, value: n } : { ok: false }
    }
    case "senderId":
      return typeof v === "string" && (v === "" || SENDER_ID_RE.test(v)) ? { ok: true, value: v } : { ok: false }
  }
}

/** Validates the WHOLE patch: the first bad field fails everything. The patch is keyed by admin_settings key. */
export function validateTtbSettings(input: unknown): ValidationOutcome {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "body_must_be_an_object" }
  const patch: Partial<Record<TtbSettingKey, unknown>> = {}
  for (const [field, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(FIELDS as string[]).includes(field)) return { ok: false, error: "unknown_field" }
    const res = check(RULES[field as TtbSettingField], value)
    if (!res.ok) return { ok: false, error: `invalid_${field}` }
    patch[TTB_SETTING_KEYS[field as TtbSettingField]] = res.value
  }
  return { ok: true, patch }
}
