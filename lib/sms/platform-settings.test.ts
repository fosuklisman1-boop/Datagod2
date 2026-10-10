import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// The module creates a Supabase client at import time; stub it so tests need no env.
const inMock = vi.hoisted(() => vi.fn())
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ select: () => ({ in: inMock }) }) }),
}))

import {
  parseSmsSettings, DEFAULT_SMS_SETTINGS, apiRateLimitFor, loadSmsSettings, invalidateSmsSettingsCache,
} from "./platform-settings"

describe("parseSmsSettings", () => {
  it("returns defaults for no rows", () => expect(parseSmsSettings([])).toEqual(DEFAULT_SMS_SETTINGS))
  it("reads scalars, arrays and caps", () => {
    const s = parseSmsSettings([
      { key: "sms_feature_enabled", value: false },
      { key: "sms_policy_enforced", value: true },
      { key: "sms_allowed_roles", value: ["shop_owner", "dealer"] },
      { key: "sms_caps", value: { platform: { per_send: 50 } } },
      { key: "sms_api_rate_limit_default", value: 12 },
      { key: "sms_hubtel_cost_per_sms", value: 0.031 },
    ])
    expect(s.featureEnabled).toBe(false)
    expect(s.policyEnforced).toBe(true)
    expect(s.allowedRoles).toEqual(["shop_owner", "dealer"])
    expect(s.caps.platform).toEqual({ per_send: 50, per_hour: 20, per_day: 500 })
    expect(s.caps.business).toEqual(DEFAULT_SMS_SETTINGS.caps.business)
    expect(s.apiRateLimitDefault).toBe(12)
    expect(s.hubtelCostPerSms).toBe(0.031)
  })
  it("tolerates legacy shapes: {enabled}, {value}, comma strings", () => {
    const s = parseSmsSettings([
      { key: "sms_feature_enabled", value: { enabled: false } },
      { key: "sms_auto_suspend_flags", value: { value: 3 } },
      { key: "sms_blocked_keywords", value: "loan, Win Big ,," },
    ])
    expect(s.featureEnabled).toBe(false)
    expect(s.autoSuspendFlags).toBe(3)
    expect(s.blockedKeywords).toEqual(["loan", "Win Big"])
  })
  it("falls back on garbage", () => {
    const s = parseSmsSettings([
      { key: "sms_api_rate_limit_default", value: -4 },
      { key: "sms_caps", value: "nope" },
      { key: "sms_sender_pool", value: 7 },
    ])
    expect(s.apiRateLimitDefault).toBe(30)
    expect(s.caps).toEqual(DEFAULT_SMS_SETTINGS.caps)
    expect(s.senderPool).toEqual([])
  })
})

describe("businessAllowedDomains normalisation", () => {
  it("strips scheme, www, path and trailing dots; drops empties", () => {
    const s = parseSmsSettings([{ key: "sms_business_allowed_domains", value: ["https://Bit.ly/", "WWW.Example.com/a/b", "foo.com.", "https://"] }])
    expect(s.businessAllowedDomains).toEqual(["bit.ly", "example.com", "foo.com"])
  })
})

describe("apiRateLimitFor", () => {
  it("prefers the account override", () => expect(apiRateLimitFor(500, 30)).toBe(500))
  it("uses the default when no override", () => expect(apiRateLimitFor(null, 30)).toBe(30))
  it("ignores out-of-range overrides", () => expect(apiRateLimitFor(0, 30)).toBe(30))
})

describe("parseSmsSettings hardening", () => {
  it("falls back to default when a non-empty list has no usable entries", () => {
    expect(parseSmsSettings([{ key: "sms_allowed_roles", value: [null] }]).allowedRoles)
      .toEqual(DEFAULT_SMS_SETTINGS.allowedRoles)
    expect(parseSmsSettings([{ key: "sms_protected_sender_names", value: [{ name: "MTN" }] }]).protectedSenderNames)
      .toEqual(DEFAULT_SMS_SETTINGS.protectedSenderNames)
  })
  it("keeps an explicit empty list empty", () => {
    expect(parseSmsSettings([{ key: "sms_sender_pool", value: [] }]).senderPool).toEqual([])
    expect(parseSmsSettings([{ key: "sms_allowed_roles", value: [] }]).allowedRoles).toEqual([])
  })
  it("accepts numeric and boolean strings", () => {
    const s = parseSmsSettings([
      { key: "sms_api_rate_limit_default", value: "45" },
      { key: "sms_hubtel_cost_per_sms", value: "0.05" },
      { key: "sms_feature_enabled", value: "FALSE" },
    ])
    expect(s.apiRateLimitDefault).toBe(45)
    expect(s.hubtelCostPerSms).toBe(0.05)
    expect(s.featureEnabled).toBe(false)
  })
  it("rejects zero cost (divide-by-zero guard) and junk strings", () => {
    expect(parseSmsSettings([{ key: "sms_hubtel_cost_per_sms", value: 0 }]).hubtelCostPerSms).toBe(0.035)
    expect(parseSmsSettings([{ key: "sms_api_rate_limit_default", value: "abc" }]).apiRateLimitDefault).toBe(30)
  })
  it("unwraps by type", () => {
    expect(parseSmsSettings([{ key: "sms_hubtel_cost_per_sms", value: { enabled: true } }]).hubtelCostPerSms).toBe(0.035)
    expect(parseSmsSettings([{ key: "sms_feature_enabled", value: { value: false } }]).featureEnabled).toBe(false)
    expect(parseSmsSettings([{ key: "sms_hubtel_low_balance_ghs", value: { amount: 80 } }]).hubtelLowBalanceGhs).toBe(80)
    expect(parseSmsSettings([{ key: "sms_caps", value: { value: { platform: { per_send: 9 } } } }]).caps.platform.per_send).toBe(9)
  })
  it("never hands out shared default state", () => {
    const s = parseSmsSettings([])
    s.allowedRoles.push("x")
    s.caps.platform.per_send = 1
    expect(DEFAULT_SMS_SETTINGS.allowedRoles).toEqual(["shop_owner", "sub_agent"])
    expect(DEFAULT_SMS_SETTINGS.caps.platform.per_send).toBe(300)
  })
})

describe("loadSmsSettings", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    inMock.mockReset()
    vi.spyOn(console, "error").mockImplementation(() => {})
    invalidateSmsSettingsCache()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  const ok = (v: number) => ({ data: [{ key: "sms_api_rate_limit_default", value: v }], error: null })
  const fail = { data: null, error: { message: "boom" } }

  it("serves from cache within 60s (one query)", async () => {
    inMock.mockResolvedValue(ok(12))
    expect((await loadSmsSettings()).apiRateLimitDefault).toBe(12)
    vi.advanceTimersByTime(59_000)
    await loadSmsSettings()
    expect(inMock).toHaveBeenCalledTimes(1)
  })
  it("returns the stale value when a refresh fails", async () => {
    inMock.mockResolvedValueOnce(ok(12))
    await loadSmsSettings()
    vi.advanceTimersByTime(61_000)
    inMock.mockResolvedValueOnce(fail)
    expect((await loadSmsSettings()).apiRateLimitDefault).toBe(12)
  })
  it("returns defaults on a cold failure", async () => {
    inMock.mockResolvedValueOnce(fail)
    expect(await loadSmsSettings()).toEqual(DEFAULT_SMS_SETTINGS)
  })
  it("does not re-query within 10s after an error, but does after", async () => {
    inMock.mockResolvedValueOnce(fail)
    await loadSmsSettings()
    vi.advanceTimersByTime(9_000)
    await loadSmsSettings()
    expect(inMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2_000)
    inMock.mockResolvedValueOnce(ok(7))
    expect((await loadSmsSettings()).apiRateLimitDefault).toBe(7)
    expect(inMock).toHaveBeenCalledTimes(2)
  })
})
