import { describe, it, expect } from "vitest"
import {
  DEFAULT_VOICE_SETTINGS,
  resolveVoiceSettings,
  voiceAudienceForContext,
  voiceAvailable,
  voiceSettingsInputSchema,
} from "./settings"

const DEFAULTS = {
  enabled: false,
  audiences: { public: false, storefront: false, dashboard: false, admin: false },
  personaId: "sam",
  expressiveness: 1,
  maxCallSeconds: 300,
  dailyCalls: { dashboard: 5, public: 1, storefront: 1 },
  visitorDailyTotal: 30,
}

describe("resolveVoiceSettings", () => {
  it("returns defaults for null / missing voice block", () => {
    expect(resolveVoiceSettings(null)).toEqual(DEFAULTS)
    expect(resolveVoiceSettings({})).toEqual(DEFAULTS)
    expect(DEFAULT_VOICE_SETTINGS).toEqual(DEFAULTS)
  })

  it("falls back per field on bad values", () => {
    const s = resolveVoiceSettings({ voice: { expressiveness: 5, personaId: "emma", maxCallSeconds: 10, visitorDailyTotal: -1, dailyCalls: { dashboard: 99, public: 2 } } })
    expect(s.expressiveness).toBe(1)
    expect(s.personaId).toBe("sam")
    expect(s.maxCallSeconds).toBe(300)
    expect(s.visitorDailyTotal).toBe(30)
    expect(s.dailyCalls).toEqual({ dashboard: 5, public: 2, storefront: 1 })
  })

  it("keeps valid values", () => {
    const s = resolveVoiceSettings({ voice: { enabled: true, audiences: { dashboard: true }, personaId: "mira", expressiveness: 0.5, maxCallSeconds: 600 } })
    expect(s.enabled).toBe(true)
    expect(s.audiences).toEqual({ public: false, storefront: false, dashboard: true, admin: false })
    expect(s.personaId).toBe("mira")
    expect(s.expressiveness).toBe(0.5)
    expect(s.maxCallSeconds).toBe(600)
  })
})

describe("voiceAvailable / voiceAudienceForContext", () => {
  it("is false when master switch off even if audience on", () => {
    const s = resolveVoiceSettings({ voice: { enabled: false, audiences: { dashboard: true } } })
    expect(voiceAvailable(s, "dashboard")).toBe(false)
  })
  it("is true only for enabled audiences when master on", () => {
    const s = resolveVoiceSettings({ voice: { enabled: true, audiences: { dashboard: true } } })
    expect(voiceAvailable(s, "dashboard")).toBe(true)
    expect(voiceAvailable(s, "public")).toBe(false)
  })
  it("maps contexts", () => {
    expect(voiceAudienceForContext("home")).toBe("public")
    expect(voiceAudienceForContext("storefront")).toBe("storefront")
    expect(voiceAudienceForContext("dashboard")).toBe("dashboard")
    expect(voiceAudienceForContext("admin")).toBe("admin")
    expect(voiceAudienceForContext("whatsapp")).toBeNull()
  })
})

describe("voiceSettingsInputSchema", () => {
  it("accepts partials and rejects out-of-range / unknown keys", () => {
    expect(voiceSettingsInputSchema.safeParse({ enabled: true }).success).toBe(true)
    expect(voiceSettingsInputSchema.safeParse({ maxCallSeconds: 10 }).success).toBe(false)
    expect(voiceSettingsInputSchema.safeParse({ personaId: "emma" }).success).toBe(false)
    expect(voiceSettingsInputSchema.safeParse({ bogus: 1 }).success).toBe(false)
  })
})
