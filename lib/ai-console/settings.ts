import { z } from "zod"
import { DEFAULT_ASSISTANT_NAME, normaliseAssistantName } from "@/lib/ai-chat-ui/assistant-name"
import { TONES, type AssistantTone } from "./tone"

export const MIN_TOOL_STEPS = 3
export const MAX_TOOL_STEPS = 25

export interface Audiences {
  admins: boolean
  signedIn: boolean
  shopVisitors: boolean
  publicVisitors: boolean
}
export type AudienceKey = keyof Audiences

export interface AssistantSettings {
  name: string
  tone: AssistantTone
  audiences: Audiences
  /** null = today's defaults (admin 20, others 10). */
  maxToolSteps: number | null
  /** Admin assistant: the route catalog tools replace the acting admin tools. Default off. */
  adminCatalog: boolean
}

const nameSchema = z.string().refine((v) => normaliseAssistantName(v) === v.trim(), {
  message: "Name must be 2-24 letters, numbers, spaces or hyphens",
}).transform((v) => v.trim())

/** Validation for admin writes. All fields optional; unknown keys are rejected. */
export const assistantSettingsInputSchema = z.object({
  assistant_name: nameSchema.optional(),
  tone: z.enum(TONES).optional(),
  audiences: z.object({
    admins: z.boolean(),
    signedIn: z.boolean(),
    shopVisitors: z.boolean(),
    publicVisitors: z.boolean(),
  }).strict().optional(),
  max_tool_steps: z.number().int().min(MIN_TOOL_STEPS).max(MAX_TOOL_STEPS).nullable().optional(),
  admin_catalog_enabled: z.boolean().optional(),
}).strict()

export type AssistantSettingsInput = z.infer<typeof assistantSettingsInputSchema>

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  name: DEFAULT_ASSISTANT_NAME,
  tone: "default",
  audiences: { admins: true, signedIn: true, shopVisitors: true, publicVisitors: true },
  maxToolSteps: null,
  adminCatalog: false,
}

/** Lenient reader: anything missing or invalid in the stored config falls back to its default. */
export function resolveAssistantSettings(cfg: unknown): AssistantSettings {
  const c = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, unknown>
  const a = (c.audiences && typeof c.audiences === "object" ? c.audiences : {}) as Record<string, unknown>
  const flag = (k: AudienceKey) => (typeof a[k] === "boolean" ? (a[k] as boolean) : true)
  const steps = c.max_tool_steps
  return {
    name: normaliseAssistantName(c.assistant_name),
    tone: (TONES as readonly string[]).includes(c.tone as string) ? (c.tone as AssistantTone) : "default",
    audiences: { admins: flag("admins"), signedIn: flag("signedIn"), shopVisitors: flag("shopVisitors"), publicVisitors: flag("publicVisitors") },
    maxToolSteps: typeof steps === "number" && Number.isInteger(steps) && steps >= MIN_TOOL_STEPS && steps <= MAX_TOOL_STEPS ? steps : null,
    adminCatalog: c.admin_catalog_enabled === true,
  }
}

/** Chat context -> audience. Signed-in users on a storefront count as shopVisitors. */
export function audienceForContext(context: string): AudienceKey {
  switch (context) {
    case "admin": return "admins"
    case "dashboard": return "signedIn"
    case "storefront": return "shopVisitors"
    default: return "publicVisitors"
  }
}

export function maxIterationsFor(context: string, s: AssistantSettings): number {
  return s.maxToolSteps ?? (context === "admin" ? 20 : 10)
}
