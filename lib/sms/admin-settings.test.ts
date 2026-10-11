import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  oldRows: [] as { key: string; value: unknown }[], upserts: [] as any[], upsertError: null as null | { message: string },
  audit: vi.fn(() => Promise.resolve()), invalidate: vi.fn(),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ in: () => Promise.resolve({ data: h.oldRows, error: null }) }),
      upsert: (rows: any) => { h.upserts.push(rows); return Promise.resolve({ error: h.upsertError }) },
    }),
  }),
}))
vi.mock("./moderation-service", () => ({ writeAuditLog: h.audit }))
vi.mock("./platform-settings", async (orig) => ({ ...(await orig<typeof import("./platform-settings")>()), invalidateSmsSettingsCache: h.invalidate }))

import { validateSection, saveSection, parsePricing } from "./admin-settings"

beforeEach(() => { h.oldRows = []; h.upserts = []; h.upsertError = null; h.audit.mockClear(); h.invalidate.mockClear() })

const rows = (r: any) => (r.ok ? r.rows : null)

describe("validateSection", () => {
  it("switch", () => {
    expect(rows(validateSection("switch", { featureEnabled: false }))).toEqual([{ key: "sms_feature_enabled", value: false }])
    expect(validateSection("switch", { featureEnabled: "no" }).ok).toBe(false)
  })
  it("caps: both modes, integers in range", () => {
    const ok = { platform: { per_send: 300, per_hour: 20, per_day: 500 }, business: { per_send: 1000, per_hour: 2000, per_day: 1000000 } }
    expect(rows(validateSection("caps", ok))).toEqual([{ key: "sms_caps", value: ok }])
    expect(validateSection("caps", { ...ok, platform: { per_send: 0, per_hour: 20, per_day: 500 } }).ok).toBe(false)
    expect(validateSection("caps", { ...ok, business: { per_send: 1.5, per_hour: 1, per_day: 1 } }).ok).toBe(false)
    expect(validateSection("caps", { platform: ok.platform }).ok).toBe(false)
  })
  it("moderation thresholds", () => {
    expect(rows(validateSection("moderation", { autoSuspendFlags: 2, flagReviewThreshold: 5 }))).toEqual([
      { key: "sms_auto_suspend_flags", value: 2 }, { key: "sms_flag_review_threshold", value: 5 },
    ])
    expect(validateSection("moderation", { autoSuspendFlags: 101, flagReviewThreshold: 5 }).ok).toBe(false)
    expect(validateSection("moderation", { autoSuspendFlags: 2, flagReviewThreshold: 501 }).ok).toBe(false)
  })
  it("api_limit 1..10000", () => {
    expect(rows(validateSection("api_limit", { apiRateLimitDefault: 30 }))).toEqual([{ key: "sms_api_rate_limit_default", value: 30 }])
    expect(validateSection("api_limit", { apiRateLimitDefault: 0 }).ok).toBe(false)
    expect(validateSection("api_limit", { apiRateLimitDefault: 10001 }).ok).toBe(false)
  })
  it("roles: known roles only, de-duplicated", () => {
    expect(rows(validateSection("roles", { allowedRoles: ["shop_owner", "dealer", "dealer"] }))).toEqual([{ key: "sms_allowed_roles", value: ["shop_owner", "dealer"] }])
    expect(validateSection("roles", { allowedRoles: ["admin"] }).ok).toBe(false)
  })
  it("sender_pool: validated, upper-cased, de-duplicated", () => {
    expect(rows(validateSection("sender_pool", { senderPool: ["alerts", "ALERTS", "Pay Co"] }))).toEqual([{ key: "sms_sender_pool", value: ["ALERTS", "PAY CO"] }])
    expect(validateSection("sender_pool", { senderPool: ["ab"] }).ok).toBe(false)
    expect(validateSection("sender_pool", { senderPool: ["bad-name!"] }).ok).toBe(false)
  })
  it("platform_keywords: trimmed, de-duplicated case-insensitively, no empties", () => {
    expect(rows(validateSection("platform_keywords", { blockedKeywords: [" Loan ", "loan", "", "win big"] }))).toEqual([{ key: "sms_blocked_keywords", value: ["Loan", "win big"] }])
    expect(validateSection("platform_keywords", { blockedKeywords: ["x".repeat(61)] }).ok).toBe(false)
  })
  it("business_lists: keywords + normalised domains", () => {
    const r = validateSection("business_lists", {
      businessBlockedKeywords: ["casino"], businessFlaggedKeywords: ["bonus"], businessAllowedDomains: ["https://WWW.Bit.ly/x", "example.com"],
    })
    expect(rows(r)).toEqual([
      { key: "sms_business_blocked_keywords", value: ["casino"] },
      { key: "sms_business_flagged_keywords", value: ["bonus"] },
      { key: "sms_business_allowed_domains", value: ["bit.ly", "example.com"] },
    ])
    expect(validateSection("business_lists", { businessBlockedKeywords: [], businessFlaggedKeywords: [], businessAllowedDomains: ["not a domain"] }).ok).toBe(false)
  })
  it("pricing keeps the legacy wrappers", () => {
    expect(rows(validateSection("pricing", { activationFee: 20, welcomeBonusCredits: 10, pricePerCredit: 0.025 }))).toEqual([
      { key: "sms_activation_fee", value: { amount: 20 } },
      { key: "sms_welcome_bonus_credits", value: { units: 10 } },
      { key: "sms_price_per_credit", value: { amount: 0.025 } },
    ])
    expect(validateSection("pricing", { activationFee: -1, welcomeBonusCredits: 10, pricePerCredit: 0.025 }).ok).toBe(false)
    expect(validateSection("pricing", { activationFee: 0, welcomeBonusCredits: 1.5, pricePerCredit: 0.025 }).ok).toBe(false)
    expect(validateSection("pricing", { activationFee: 0, welcomeBonusCredits: 0, pricePerCredit: 0 }).ok).toBe(false)
  })
  it("hubtel cost + low-balance threshold", () => {
    expect(rows(validateSection("hubtel", { hubtelCostPerSms: 0.035, hubtelLowBalanceGhs: 50 }))).toEqual([
      { key: "sms_hubtel_cost_per_sms", value: 0.035 }, { key: "sms_hubtel_low_balance_ghs", value: 50 },
    ])
    expect(validateSection("hubtel", { hubtelCostPerSms: 0, hubtelLowBalanceGhs: 50 }).ok).toBe(false)
  })
  it("refuses unknown sections, including the enforcement flag", () => {
    expect(validateSection("enforcement", { policyEnforced: true }).ok).toBe(false)
    expect(validateSection("nope", {}).ok).toBe(false)
    expect(validateSection("switch", null).ok).toBe(false)
  })
})

describe("saveSection", () => {
  it("validates, upserts, audits old/new, invalidates the cache", async () => {
    h.oldRows = [{ key: "sms_feature_enabled", value: true }]
    const r = await saveSection("admin1", "switch", { featureEnabled: false })
    expect(r).toEqual({ ok: true, updated: ["sms_feature_enabled"] })
    expect(h.upserts[0]).toEqual([{ key: "sms_feature_enabled", value: false }])
    expect(h.audit).toHaveBeenCalledWith("admin1", "sms_settings_update", null,
      { section: "switch", values: { sms_feature_enabled: true } }, { section: "switch", values: { sms_feature_enabled: false } })
    expect(h.invalidate).toHaveBeenCalledOnce()
  })
  it("invalid input writes nothing", async () => {
    const r = await saveSection("admin1", "api_limit", { apiRateLimitDefault: 0 })
    expect(r.ok).toBe(false)
    expect(h.upserts).toHaveLength(0)
    expect(h.audit).not.toHaveBeenCalled()
  })
  it("a database error is reported, not audited, cache untouched", async () => {
    h.upsertError = { message: "db down" }
    const r = await saveSection("admin1", "switch", { featureEnabled: true })
    expect(r).toEqual({ ok: false, error: "Could not save settings" })
    expect(h.audit).not.toHaveBeenCalled()
    expect(h.invalidate).not.toHaveBeenCalled()
  })
  it("refuses a missing admin id", async () => {
    expect((await saveSection("", "switch", { featureEnabled: true })).ok).toBe(false)
    expect(h.upserts).toHaveLength(0)
  })
})

describe("parsePricing", () => {
  it("reads wrapped and bare values, with safe defaults", () => {
    expect(parsePricing([
      { key: "sms_activation_fee", value: { amount: 20 } }, { key: "sms_welcome_bonus_credits", value: { units: 10 } }, { key: "sms_price_per_credit", value: 0.04 },
    ])).toEqual({ activationFee: 20, welcomeBonusCredits: 10, pricePerCredit: 0.04 })
    expect(parsePricing([])).toEqual({ activationFee: 0, welcomeBonusCredits: 0, pricePerCredit: 0.04 })
  })
})
