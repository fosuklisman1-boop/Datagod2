import type { ProviderName } from "@/lib/ai-provider-config"
import type { Audiences } from "./settings"
import type { AssistantTone } from "./tone"

export const PROVIDERS: ProviderName[] = ["anthropic", "openai", "gemini", "deepseek", "groq"]
export const CONSOLE_TABS = ["settings", "knowledge", "conversations", "flags"] as const
export type ConsoleTab = (typeof CONSOLE_TABS)[number]

export function parseTab(value: string | string[] | undefined | null): ConsoleTab {
  const v = Array.isArray(value) ? value[0] : value
  return (CONSOLE_TABS as readonly string[]).includes(v as string) ? (v as ConsoleTab) : "settings"
}

export type ChatContext = "storefront" | "dashboard" | "admin" | "whatsapp"
/** Contexts edited together by the Engine card. WhatsApp stays an Advanced override. */
export const GLOBAL_CONTEXTS: ChatContext[] = ["storefront", "dashboard", "admin"]

export interface ConsoleForm {
  assistant_name: string
  tone: AssistantTone
  audiences: Audiences
  max_tool_steps: number | null
  storefront_provider: ProviderName
  storefront_model: string
  dashboard_provider: ProviderName
  dashboard_model: string
  admin_provider: ProviderName
  admin_model: string
  whatsapp_provider: ProviderName
  whatsapp_model: string
  /** Write-only new keys; empty = untouched. */
  keys: Record<ProviderName, string>
}

export function globalEngine(f: ConsoleForm): { provider: ProviderName; model: string } | null {
  const p = f.dashboard_provider
  const m = f.dashboard_model
  const same = GLOBAL_CONTEXTS.every((c) => f[`${c}_provider`] === p && f[`${c}_model`] === m)
  return same ? { provider: p, model: m } : null
}

export function applyEngine(f: ConsoleForm, provider: ProviderName, model: string): ConsoleForm {
  return {
    ...f,
    storefront_provider: provider, storefront_model: model,
    dashboard_provider: provider, dashboard_model: model,
    admin_provider: provider, admin_model: model,
  }
}

/** The "Other model" card is highlighted only for one shared non-catalog model; while contexts differ (mixed) nothing is. */
export function otherModelSelected(catalogIds: string[], model: string, mixed: boolean): boolean {
  return !mixed && !catalogIds.includes(model)
}

/** True when any chat context has a blank model id (the "Other model" box was cleared). */
export function hasEmptyModel(f: ConsoleForm): boolean {
  return [f.storefront_model, f.dashboard_model, f.admin_model, f.whatsapp_model].some((m) => m.trim() === "")
}

const SCALAR_FIELDS = [
  "assistant_name", "tone", "max_tool_steps",
  "storefront_provider", "storefront_model", "dashboard_provider", "dashboard_model",
  "admin_provider", "admin_model", "whatsapp_provider", "whatsapp_model",
] as const

/** Only the fields that differ, shaped for PUT /api/admin/ai-config. */
export function changedSettings(original: ConsoleForm, edited: ConsoleForm): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of SCALAR_FIELDS) {
    const v = edited[k]
    const sent = typeof v === "string" ? v.trim() : v
    // A context with a blank model id sends neither its model nor its provider
    // (the form also blocks Save; see hasEmptyModel).
    const ctx = k.match(/^(storefront|dashboard|admin|whatsapp)_(provider|model)$/)?.[1]
    if (ctx && (edited[`${ctx}_model` as keyof ConsoleForm] as string).trim() === "") continue
    if (original[k] !== sent) out[k] = sent
  }
  const a = original.audiences, b = edited.audiences
  if (a.admins !== b.admins || a.signedIn !== b.signedIn || a.shopVisitors !== b.shopVisitors || a.publicVisitors !== b.publicVisitors) {
    out.audiences = { ...b }
  }
  for (const p of PROVIDERS) {
    const key = edited.keys[p].trim()
    if (key) out[`${p}_api_key_new`] = key
  }
  return out
}
