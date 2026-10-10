import { describe, it, expect, vi } from "vitest"

// The module creates a Supabase client at import time; stub it so tests need no env.
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))

import { parseSmsSettings, DEFAULT_SMS_SETTINGS, apiRateLimitFor } from "./platform-settings"

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

describe("apiRateLimitFor", () => {
  it("prefers the account override", () => expect(apiRateLimitFor(500, 30)).toBe(500))
  it("uses the default when no override", () => expect(apiRateLimitFor(null, 30)).toBe(30))
  it("ignores out-of-range overrides", () => expect(apiRateLimitFor(0, 30)).toBe(30))
})
