import { z } from "zod"

export type VoiceAudience = "public" | "storefront" | "dashboard" | "admin"
export type VoicePersonaId = "sam" | "sonia" | "mira"

export interface VoiceSettings {
  enabled: boolean
  audiences: Record<VoiceAudience, boolean>
  personaId: VoicePersonaId
  expressiveness: number // 0..2
  maxCallSeconds: number // 60..1800
  dailyCalls: { dashboard: number; public: number; storefront: number } // 0..50 (admins: no cap)
  visitorDailyTotal: number // 0..1000
  multiAccount: boolean // use NUANCE_API_KEY_2..9 too (Nuance beta); off = account 1 only
  callsPerKey: number // 1..20 calls at once per Nuance account (free beta plan: 1)
}

export const VOICE_PERSONA_IDS = ["sam", "sonia", "mira"] as const
const AUDIENCES = ["public", "storefront", "dashboard", "admin"] as const
const CAP_KEYS = ["dashboard", "public", "storefront"] as const

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  audiences: { public: false, storefront: false, dashboard: false, admin: false },
  personaId: "sam",
  expressiveness: 1,
  maxCallSeconds: 300,
  dailyCalls: { dashboard: 5, public: 1, storefront: 1 },
  visitorDailyTotal: 30,
  multiAccount: false,
  callsPerKey: 1,
}

const dailyCap = z.number().int().min(0).max(50)

/** Validation for admin writes: every field optional, nested objects partial, unknown keys rejected. */
export const voiceSettingsInputSchema = z.object({
  enabled: z.boolean(),
  audiences: z.object({
    public: z.boolean(), storefront: z.boolean(), dashboard: z.boolean(), admin: z.boolean(),
  }).partial().strict(),
  personaId: z.enum(VOICE_PERSONA_IDS),
  expressiveness: z.number().min(0).max(2),
  maxCallSeconds: z.number().int().min(60).max(1800),
  dailyCalls: z.object({ dashboard: dailyCap, public: dailyCap, storefront: dailyCap }).partial().strict(),
  visitorDailyTotal: z.number().int().min(0).max(1000),
  multiAccount: z.boolean(),
  callsPerKey: z.number().int().min(1).max(20),
}).partial().strict()

export type VoiceSettingsInput = z.infer<typeof voiceSettingsInputSchema>

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {})
const intIn = (v: unknown, min: number, max: number, dflt: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : dflt

/** Lenient reader: reads cfg.voice; anything missing or invalid falls back to its default, per field. */
export function resolveVoiceSettings(cfg: unknown): VoiceSettings {
  const v = obj(obj(cfg).voice)
  const a = obj(v.audiences)
  const d = obj(v.dailyCalls)
  const D = DEFAULT_VOICE_SETTINGS
  const expr = v.expressiveness
  return {
    enabled: v.enabled === true,
    audiences: Object.fromEntries(
      AUDIENCES.map((k) => [k, typeof a[k] === "boolean" ? (a[k] as boolean) : D.audiences[k]]),
    ) as Record<VoiceAudience, boolean>,
    personaId: (VOICE_PERSONA_IDS as readonly string[]).includes(v.personaId as string) ? (v.personaId as VoicePersonaId) : D.personaId,
    expressiveness: typeof expr === "number" && Number.isFinite(expr) && expr >= 0 && expr <= 2 ? expr : D.expressiveness,
    maxCallSeconds: intIn(v.maxCallSeconds, 60, 1800, D.maxCallSeconds),
    dailyCalls: Object.fromEntries(
      CAP_KEYS.map((k) => [k, intIn(d[k], 0, 50, D.dailyCalls[k])]),
    ) as VoiceSettings["dailyCalls"],
    visitorDailyTotal: intIn(v.visitorDailyTotal, 0, 1000, D.visitorDailyTotal),
    multiAccount: v.multiAccount === true,
    callsPerKey: intIn(v.callsPerKey, 1, 20, D.callsPerKey),
  }
}

/** Chat context -> voice audience (home page counts as public). null = no voice for that context. */
export function voiceAudienceForContext(context: string): VoiceAudience | null {
  switch (context) {
    case "home": return "public"
    case "storefront": return "storefront"
    case "dashboard": return "dashboard"
    case "admin": return "admin"
    default: return null
  }
}

export function voiceAvailable(s: VoiceSettings, a: VoiceAudience): boolean {
  return s.enabled && s.audiences[a]
}
