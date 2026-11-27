import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import {
  parsePhoneLoginSettings,
  getPhoneLoginSettings,
  getPhoneLoginSettingsStrict,
  setPhoneLoginSettings,
  DEFAULT_PHONE_LOGIN_SETTINGS,
  PHONE_LOGIN_ENABLED_KEY,
  PHONE_LOGIN_NEW_DEVICE_CODE_KEY,
  _resetPhoneLoginSettingsMemo,
} from "./settings"

describe("parsePhoneLoginSettings", () => {
  it("defaults: enabled fails closed (false), newDeviceCode defaults true", () => {
    expect(DEFAULT_PHONE_LOGIN_SETTINGS).toEqual({ enabled: false, newDeviceCode: true })
    expect(parsePhoneLoginSettings({})).toEqual({ enabled: false, newDeviceCode: true })
    expect(parsePhoneLoginSettings(null)).toEqual({ enabled: false, newDeviceCode: true })
  })

  it("accepts JSON booleans", () => {
    expect(
      parsePhoneLoginSettings({ [PHONE_LOGIN_ENABLED_KEY]: true, [PHONE_LOGIN_NEW_DEVICE_CODE_KEY]: false })
    ).toEqual({ enabled: true, newDeviceCode: false })
  })

  it("parses the strings 'true' and 'false' (older rows / other writers)", () => {
    expect(
      parsePhoneLoginSettings({ [PHONE_LOGIN_ENABLED_KEY]: "true", [PHONE_LOGIN_NEW_DEVICE_CODE_KEY]: "false" })
    ).toEqual({ enabled: true, newDeviceCode: false })
    expect(parsePhoneLoginSettings({ [PHONE_LOGIN_ENABLED_KEY]: "false" }).enabled).toBe(false)
  })

  it("anything else falls back to that key's default", () => {
    const s = parsePhoneLoginSettings({ [PHONE_LOGIN_ENABLED_KEY]: "yes", [PHONE_LOGIN_NEW_DEVICE_CODE_KEY]: 0 })
    expect(s).toEqual({ enabled: false, newDeviceCode: true })
    expect(parsePhoneLoginSettings({ [PHONE_LOGIN_ENABLED_KEY]: 1 }).enabled).toBe(false)
    expect(parsePhoneLoginSettings({ [PHONE_LOGIN_ENABLED_KEY]: { on: true } }).enabled).toBe(false)
  })

  it("newDeviceCode defaults to true even when only enabled is present", () => {
    expect(parsePhoneLoginSettings({ [PHONE_LOGIN_ENABLED_KEY]: true })).toEqual({
      enabled: true,
      newDeviceCode: true,
    })
  })
})

describe("getPhoneLoginSettings memo", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetPhoneLoginSettingsMemo()
  })
  afterEach(() => vi.useRealTimers())

  it("reads once within 30s, again after 31s, and always when fresh", async () => {
    const load = vi.fn(async () => ({ [PHONE_LOGIN_ENABLED_KEY]: true }))
    expect((await getPhoneLoginSettings({ load })).enabled).toBe(true)
    await getPhoneLoginSettings({ load })
    expect(load).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(31_000)
    await getPhoneLoginSettings({ load })
    expect(load).toHaveBeenCalledTimes(2)

    await getPhoneLoginSettings({ load, fresh: true })
    expect(load).toHaveBeenCalledTimes(3)
  })

  it("a load error gives enabled:false (fails closed)", async () => {
    const load = vi.fn(async () => {
      throw new Error("db down")
    })
    expect(await getPhoneLoginSettings({ load })).toEqual({ enabled: false, newDeviceCode: true })
  })

  it("a missing row gives the defaults", async () => {
    expect(await getPhoneLoginSettings({ load: async () => ({}), fresh: true })).toEqual(
      DEFAULT_PHONE_LOGIN_SETTINGS
    )
  })
})

// Minimal chainable fake: from().select().in() resolves to { data, error }.
type Row = { key: string; value: unknown }
const fakeClient = (result: { data: Row[] | null; error: unknown }, calls: { upsert?: unknown[] } = {}) =>
  ({
    from: (table: string) => {
      expect(table).toBe("admin_settings")
      return {
        select: () => ({ in: async () => result }),
        upsert: async (rows: unknown, opts: unknown) => {
          calls.upsert = [rows, opts]
          return { error: (result as { upsertError?: unknown }).upsertError ?? null }
        },
      }
    },
  }) as never

describe("getPhoneLoginSettingsStrict", () => {
  it("throws on a DB error", async () => {
    await expect(getPhoneLoginSettingsStrict(fakeClient({ data: null, error: new Error("db") }))).rejects.toThrow("db")
  })

  it("missing rows give the defaults", async () => {
    expect(await getPhoneLoginSettingsStrict(fakeClient({ data: [], error: null }))).toEqual(
      DEFAULT_PHONE_LOGIN_SETTINGS
    )
  })

  it("parses stored rows, one row per key", async () => {
    const s = await getPhoneLoginSettingsStrict(
      fakeClient({
        data: [
          { key: PHONE_LOGIN_ENABLED_KEY, value: true },
          { key: PHONE_LOGIN_NEW_DEVICE_CODE_KEY, value: "false" },
        ],
        error: null,
      })
    )
    expect(s).toEqual({ enabled: true, newDeviceCode: false })
  })
})

describe("setPhoneLoginSettings", () => {
  it("upserts both rows with JSON booleans, onConflict key", async () => {
    const calls: { upsert?: unknown[] } = {}
    await setPhoneLoginSettings(fakeClient({ data: [], error: null }, calls), { enabled: true, newDeviceCode: false })
    expect(calls.upsert).toEqual([
      [
        { key: PHONE_LOGIN_ENABLED_KEY, value: true },
        { key: PHONE_LOGIN_NEW_DEVICE_CODE_KEY, value: false },
      ],
      { onConflict: "key" },
    ])
  })

  it("throws when the upsert fails", async () => {
    const failing = {
      from: () => ({ upsert: async () => ({ error: new Error("write failed") }) }),
    } as never
    await expect(setPhoneLoginSettings(failing, DEFAULT_PHONE_LOGIN_SETTINGS)).rejects.toThrow("write failed")
  })
})
