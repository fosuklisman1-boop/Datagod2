import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { loadTtbSettings, TTB_DEFAULTS } from "./settings"

type Result = { data: unknown; error: unknown }
function client(result: Result | (() => never)): SupabaseClient {
  return {
    from: (table: string) => {
      if (table !== "admin_settings") throw new Error("wrong table " + table)
      return {
        select: () => ({
          in: (col: string, keys: string[]) => {
            if (col !== "key" || !keys.every((k) => k.startsWith("ttb_"))) throw new Error("bad filter")
            return typeof result === "function" ? result() : Promise.resolve(result)
          },
        }),
      }
    },
  } as unknown as SupabaseClient
}
const rows = (o: Record<string, unknown>) => ({
  data: Object.entries(o).map(([key, value]) => ({ key, value: { value } })),
  error: null,
})

describe("TTB_DEFAULTS", () => {
  it("is off, with the seeded limits", () => {
    expect(TTB_DEFAULTS).toEqual({
      mainEnabled: false, mainNumber: "", replySenderId: "", aiEnabled: true, staleMinutes: 10, promptsPerHour: 3,
      repliesPerHour: 6, aiReadsPerHour: 10, globalPromptsPerMinute: 30, promptWindowMinutes: 5, quietAlertMinutes: 60,
      retentionDays: 30, source: "defaults",
    })
  })
})

describe("loadTtbSettings", () => {
  it("returns defaults when the read errors", async () => {
    expect(await loadTtbSettings(client({ data: null, error: { message: "boom" } }))).toEqual(TTB_DEFAULTS)
  })

  it("returns defaults when the read throws", async () => {
    expect(await loadTtbSettings(client(() => { throw new Error("down") }))).toEqual(TTB_DEFAULTS)
  })

  it("returns defaults (source db, off) when rows are missing", async () => {
    const s = await loadTtbSettings(client({ data: [], error: null }))
    expect(s).toEqual({ ...TTB_DEFAULTS, source: "db" })
    expect(s.mainEnabled).toBe(false)
  })

  it("turns the main line on only for exactly true", async () => {
    expect((await loadTtbSettings(client(rows({ ttb_main_enabled: true })))).mainEnabled).toBe(true)
    for (const v of ["true", 1, "yes", null, [true], {}]) {
      expect((await loadTtbSettings(client(rows({ ttb_main_enabled: v })))).mainEnabled).toBe(false)
    }
  })

  it("reads every stored value", async () => {
    const s = await loadTtbSettings(client(rows({
      ttb_main_enabled: true, ttb_main_number: "0200000100", ttb_reply_sender_id: "Datagod", ttb_ai_enabled: false,
      ttb_stale_minutes: 15, ttb_prompts_per_hour: 4, ttb_replies_per_hour: 8, ttb_ai_reads_per_hour: 12,
      ttb_global_prompts_per_minute: 40, ttb_prompt_window_minutes: 7, ttb_quiet_alert_minutes: 90, ttb_retention_days: 14,
    })))
    expect(s).toEqual({
      mainEnabled: true, mainNumber: "0200000100", replySenderId: "Datagod", aiEnabled: false, staleMinutes: 15,
      promptsPerHour: 4, repliesPerHour: 8, aiReadsPerHour: 12, globalPromptsPerMinute: 40, promptWindowMinutes: 7,
      quietAlertMinutes: 90, retentionDays: 14, source: "db",
    })
  })

  it("falls back to the default for a non-numeric, negative or non-finite limit", async () => {
    const s = await loadTtbSettings(client(rows({
      ttb_stale_minutes: "soon", ttb_prompts_per_hour: -1, ttb_replies_per_hour: null, ttb_ai_reads_per_hour: Number.NaN,
      ttb_global_prompts_per_minute: [], ttb_prompt_window_minutes: -0.5, ttb_quiet_alert_minutes: "60", ttb_retention_days: {},
    })))
    expect(s).toMatchObject({
      staleMinutes: 10, promptsPerHour: 3, repliesPerHour: 6, aiReadsPerHour: 10, globalPromptsPerMinute: 30,
      promptWindowMinutes: 5, quietAlertMinutes: 60, retentionDays: 30,
    })
  })

  it("keeps the default for the text settings and ai flag when the stored type is wrong", async () => {
    const s = await loadTtbSettings(client(rows({ ttb_main_number: 5, ttb_reply_sender_id: null, ttb_ai_enabled: "no" })))
    expect(s).toMatchObject({ mainNumber: "", replySenderId: "", aiEnabled: true })
  })

  it("ignores a row whose value is not an object", async () => {
    const s = await loadTtbSettings(client({ data: [{ key: "ttb_main_enabled", value: true }], error: null }))
    expect(s.mainEnabled).toBe(false)
  })
})
