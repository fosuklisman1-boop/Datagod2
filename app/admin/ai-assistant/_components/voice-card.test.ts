import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))

import { toVoiceDraft, voiceErrors, voiceFromDraft } from "./voice-card"
import { DEFAULT_VOICE_SETTINGS } from "@/lib/ai-voice/settings"

describe("voice card: waiting line fields", () => {
  it("shows the stored values as text", () => {
    const d = toVoiceDraft({ ...DEFAULT_VOICE_SETTINGS, queueEnabled: true, queueMax: 20, queueMaxWaitMinutes: 15 })
    expect(d.queueMax).toBe("20")
    expect(d.queueMaxWaitMinutes).toBe("15")
    expect(d.settings.queueEnabled).toBe(true)
  })
  it("flags out-of-range or blank values", () => {
    const d = toVoiceDraft(DEFAULT_VOICE_SETTINGS)
    expect(voiceErrors(d)).toEqual({})
    expect(voiceErrors({ ...d, queueMax: "0" }).queueMax).toBeTruthy()
    expect(voiceErrors({ ...d, queueMax: "101" }).queueMax).toBeTruthy()
    expect(voiceErrors({ ...d, queueMax: "" }).queueMax).toBeTruthy()
    expect(voiceErrors({ ...d, queueMaxWaitMinutes: "0" }).queueMaxWaitMinutes).toBeTruthy()
    expect(voiceErrors({ ...d, queueMaxWaitMinutes: "61" }).queueMaxWaitMinutes).toBeTruthy()
    expect(voiceErrors({ ...d, queueMaxWaitMinutes: "2.5" }).queueMaxWaitMinutes).toBeTruthy()
  })
  it("turns the draft back into numbers", () => {
    const d = { ...toVoiceDraft(DEFAULT_VOICE_SETTINGS), queueMax: "30", queueMaxWaitMinutes: "7" }
    expect(voiceFromDraft(d)).toMatchObject({ queueMax: 30, queueMaxWaitMinutes: 7 })
  })
})
