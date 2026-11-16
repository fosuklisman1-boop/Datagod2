import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import {
  parseBlockedSettings,
  getBlockedNumbersSettings,
  getBlockedNumbersSettingsStrict,
  DEFAULT_BLOCKED_SETTINGS,
  _resetSettingsMemo,
} from "./settings"
import { BLOCK_SURFACES, SMS_SURFACES } from "./types"

describe("parseBlockedSettings", () => {
  it("null gives defaults", () => {
    expect(parseBlockedSettings(null)).toEqual(DEFAULT_BLOCKED_SETTINGS)
    expect(DEFAULT_BLOCKED_SETTINGS).toEqual({
      enabled: false,
      customer_sms_enabled: false,
      retention_days: 30,
      spike_threshold_per_hour: 25,
      daily_sms_ceiling: 300,
    })
  })

  it("partial value keeps the rest default", () => {
    expect(parseBlockedSettings({ enabled: true })).toEqual({ ...DEFAULT_BLOCKED_SETTINGS, enabled: true })
  })

  it("clamps retention_days to 1..365", () => {
    expect(parseBlockedSettings({ retention_days: 0 }).retention_days).toBe(1)
    expect(parseBlockedSettings({ retention_days: 400 }).retention_days).toBe(365)
  })

  it("clamps daily_sms_ceiling to 0..10000 and spike threshold to 1..10000", () => {
    expect(parseBlockedSettings({ daily_sms_ceiling: -5 }).daily_sms_ceiling).toBe(0)
    expect(parseBlockedSettings({ daily_sms_ceiling: 99999 }).daily_sms_ceiling).toBe(10000)
    expect(parseBlockedSettings({ spike_threshold_per_hour: 0 }).spike_threshold_per_hour).toBe(1)
  })

  it("floors to integers", () => {
    expect(parseBlockedSettings({ retention_days: 12.9 }).retention_days).toBe(12)
  })

  it("non-boolean flags and non-numeric numbers fall back to defaults", () => {
    const s = parseBlockedSettings({ enabled: "yes", customer_sms_enabled: 1, retention_days: "7" })
    expect(s.enabled).toBe(false)
    expect(s.customer_sms_enabled).toBe(false)
    expect(s.retention_days).toBe(30)
  })
})

describe("getBlockedNumbersSettings memo", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetSettingsMemo()
  })
  afterEach(() => vi.useRealTimers())

  it("reads once within 60s, again after 61s, and always when fresh", async () => {
    const load = vi.fn(async () => ({ enabled: true }))
    expect((await getBlockedNumbersSettings({ load })).enabled).toBe(true)
    await getBlockedNumbersSettings({ load })
    expect(load).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(61_000)
    await getBlockedNumbersSettings({ load })
    expect(load).toHaveBeenCalledTimes(2)

    await getBlockedNumbersSettings({ load, fresh: true })
    expect(load).toHaveBeenCalledTimes(3)
  })

  it("any error gives defaults", async () => {
    const load = vi.fn(async () => {
      throw new Error("db down")
    })
    expect(await getBlockedNumbersSettings({ load })).toEqual(DEFAULT_BLOCKED_SETTINGS)
  })
})

describe("getBlockedNumbersSettingsStrict", () => {
  const client = (result: { data: unknown; error: unknown }) =>
    ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => result }) }) }) }) as never

  it("throws on a DB error", async () => {
    await expect(getBlockedNumbersSettingsStrict(client({ data: null, error: new Error("db") }))).rejects.toThrow("db")
  })
  it("missing row gives defaults", async () => {
    expect(await getBlockedNumbersSettingsStrict(client({ data: null, error: null }))).toEqual(DEFAULT_BLOCKED_SETTINGS)
  })
  it("parses a stored value", async () => {
    const s = await getBlockedNumbersSettingsStrict(client({ data: { value: { enabled: true } }, error: null }))
    expect(s.enabled).toBe(true)
  })
})

describe("surfaces", () => {
  it("SMS_SURFACES has no dealer surfaces", () => {
    for (const s of SMS_SURFACES) {
      expect(s.startsWith("dashboard")).toBe(false)
      expect(["api_v1", "api_v2"]).not.toContain(s)
    }
  })

  it("BLOCK_SURFACES equals the migration 0182 CHECK list, in order", () => {
    const sql = readFileSync(join(__dirname, "../../migrations/0182_mtn_blocked_numbers.sql"), "utf8")
    const m = sql.match(/surface\s+text NOT NULL CHECK \(surface IN \(([^)]*)\)\)/)
    expect(m).not.toBeNull()
    const listed = [...m![1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])
    expect(listed).toEqual([...BLOCK_SURFACES])
  })

  it("SMS_SURFACES are all valid surfaces", () => {
    expect(SMS_SURFACES).toHaveLength(10)
    for (const s of SMS_SURFACES) expect(BLOCK_SURFACES).toContain(s)
  })
})
