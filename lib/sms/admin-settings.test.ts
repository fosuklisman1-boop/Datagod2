import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  oldRows: [] as { key: string; value: unknown }[], selectError: null as null | { message: string }, upserts: [] as any[], upsertError: null as null | { message: string },
  audit: vi.fn(() => Promise.resolve()), invalidate: vi.fn(),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ in: () => Promise.resolve({ data: h.oldRows, error: h.selectError }) }),
      upsert: (rows: any) => { h.upserts.push(rows); return Promise.resolve({ error: h.upsertError }) },
    }),
  }),
}))
vi.mock("./moderation-service", () => ({ writeAuditLog: h.audit }))
vi.mock("./platform-settings", async (orig) => ({ ...(await orig<typeof import("./platform-settings")>()), invalidateSmsSettingsCache: h.invalidate }))

import { validateSection, saveSection, parsePricing, getAdminSettings } from "./admin-settings"

beforeEach(() => { h.selectError = null; h.oldRows = []; h.upserts = []; h.upsertError = null; h.audit.mockClear(); h.invalidate.mockClear() })

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
  it("platform_senders: validated, upper-cased, de-duplicated; default must be in the list", () => {
    expect(rows(validateSection("platform_senders", { platformSenders: ["clingdtgod2", "CLINGDTGOD2", "Kings Co"], platformDefaultSender: "clingdtgod2" })))
      .toEqual([{ key: "sms_platform_senders", value: ["CLINGDTGOD2", "KINGS CO"] }, { key: "sms_platform_default_sender", value: "CLINGDTGOD2" }])
    // no default: stored as "" (value column is NOT NULL jsonb)
    expect(rows(validateSection("platform_senders", { platformSenders: ["ABC"], platformDefaultSender: null })))
      .toEqual([{ key: "sms_platform_senders", value: ["ABC"] }, { key: "sms_platform_default_sender", value: "" }])
    expect(rows(validateSection("platform_senders", { platformSenders: [], platformDefaultSender: "" })))
      .toEqual([{ key: "sms_platform_senders", value: [] }, { key: "sms_platform_default_sender", value: "" }])
  })
  it("platform_senders: rejects bad names, 12 chars, >20 names", () => {
    expect(validateSection("platform_senders", { platformSenders: ["ab"], platformDefaultSender: null }).ok).toBe(false)
    expect(validateSection("platform_senders", { platformSenders: ["CLINGSDTGOD1"], platformDefaultSender: null }).ok).toBe(false)
    expect(validateSection("platform_senders", { platformSenders: ["bad-name!"], platformDefaultSender: null }).ok).toBe(false)
    expect(validateSection("platform_senders", { platformSenders: "ABC", platformDefaultSender: null }).ok).toBe(false)
    const many = Array.from({ length: 21 }, (_, i) => `NAME${String.fromCharCode(65 + i)}`)
    expect(validateSection("platform_senders", { platformSenders: many, platformDefaultSender: null }).ok).toBe(false)
    expect(validateSection("platform_senders", { platformSenders: many.slice(0, 20), platformDefaultSender: null }).ok).toBe(true)
  })
  it("platform_senders: default not in list is rejected with a clear message", () => {
    const r = validateSection("platform_senders", { platformSenders: ["ABC"], platformDefaultSender: "XYZ" })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/default.*XYZ.*not in the list/i)
    // removing the current default from the list while it is still selected
    expect(validateSection("platform_senders", { platformSenders: [], platformDefaultSender: "ABC" }).ok).toBe(false)
  })
  it("platform_senders saves through saveSection, audits and invalidates the cache", async () => {
    const r = await saveSection("admin1", "platform_senders", { platformSenders: ["ABC"], platformDefaultSender: "ABC" })
    expect(r.ok).toBe(true)
    expect(h.upserts[0]).toHaveLength(2)
    expect(h.audit).toHaveBeenCalledOnce()
    expect(h.invalidate).toHaveBeenCalledOnce()
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
    expect(validateSection("pricing", { activationFee: 0, welcomeBonusCredits: 0, pricePerCredit: 0.025 }).ok).toBe(false)
    expect(validateSection("pricing", { activationFee: 0, welcomeBonusCredits: 1, pricePerCredit: 0.0005 }).ok).toBe(false)
    expect(rows(validateSection("pricing", { activationFee: 20.005, welcomeBonusCredits: 1, pricePerCredit: 0.001 }))[0])
      .toEqual({ key: "sms_activation_fee", value: { amount: Math.round(20.005 * 100) / 100 } })
    expect(validateSection("pricing", { activationFee: 0, welcomeBonusCredits: 0, pricePerCredit: 0 }).ok).toBe(false)
  })
  it("hubtel cost + low-balance threshold", () => {
    expect(rows(validateSection("hubtel", { hubtelCostPerSms: 0.035, hubtelLowBalanceGhs: 50 }))).toEqual([
      { key: "sms_hubtel_cost_per_sms", value: 0.035 }, { key: "sms_hubtel_low_balance_ghs", value: 50 },
    ])
    expect(validateSection("hubtel", { hubtelCostPerSms: 0, hubtelLowBalanceGhs: 50 }).ok).toBe(false)
  })
  describe("hubtel_manual_balance", () => {
    const ctx = { adminId: "admin-9", now: new Date("2026-10-12T09:30:00.000Z") }
    it("server-stamps setAt and setBy (client-supplied ones are ignored)", () => {
      expect(rows(validateSection("hubtel_manual_balance", { amountGhs: 150.25, setAt: "2020-01-01T00:00:00Z", setBy: "evil" }, ctx))).toEqual([
        { key: "sms_hubtel_manual_balance", value: { amountGhs: 150.25, setAt: "2026-10-12T09:30:00.000Z", setBy: "admin-9" } },
      ])
    })
    it("accepts 0 and 1,000,000", () => {
      expect(validateSection("hubtel_manual_balance", { amountGhs: 0 }, ctx).ok).toBe(true)
      expect(validateSection("hubtel_manual_balance", { amountGhs: 1_000_000 }, ctx).ok).toBe(true)
    })
    it.each([[-0.01], [1_000_000.01], [NaN], [Infinity], ["100"], [undefined], [12.345]])("rejects %s", (amountGhs) => {
      expect(validateSection("hubtel_manual_balance", { amountGhs }, ctx).ok).toBe(false)
    })
    it("normalises float noise to 2 decimals", () => {
      const r = rows(validateSection("hubtel_manual_balance", { amountGhs: 0.1 + 0.2 }, ctx))
      expect(r[0].value.amountGhs).toBe(0.3)
    })
    it("null clears it (stored as a cleared marker that parses to no balance), still stamped", () => {
      expect(rows(validateSection("hubtel_manual_balance", { amountGhs: null }, ctx))).toEqual([
        { key: "sms_hubtel_manual_balance", value: { amountGhs: null, setAt: "2026-10-12T09:30:00.000Z", setBy: "admin-9" } },
      ])
    })
    it("requires a real admin id", () => {
      expect(validateSection("hubtel_manual_balance", { amountGhs: 5 }).ok).toBe(false)
      expect(validateSection("hubtel_manual_balance", { amountGhs: 5 }, { adminId: "" }).ok).toBe(false)
    })
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
  it("aborts when the current values cannot be read", async () => {
    h.selectError = { message: "x" }
    const r = await saveSection("admin1", "switch", { featureEnabled: true })
    expect(r).toEqual({ ok: false, error: "Could not read the current settings" })
    expect(h.upserts).toHaveLength(0)
    expect(h.audit).not.toHaveBeenCalled()
  })
  it("hubtel_manual_balance: stamps the saving admin + now, audits old/new, invalidates the cache", async () => {
    const old = { amountGhs: 50, setAt: "2026-10-01T00:00:00.000Z", setBy: "admin-0" }
    h.oldRows = [{ key: "sms_hubtel_manual_balance", value: old }]
    const before = Date.now()
    const r = await saveSection("admin1", "hubtel_manual_balance", { amountGhs: 99, setBy: "someone-else" })
    expect(r).toEqual({ ok: true, updated: ["sms_hubtel_manual_balance"] })
    const written = h.upserts[0][0].value
    expect(written.amountGhs).toBe(99)
    expect(written.setBy).toBe("admin1")
    expect(Date.parse(written.setAt)).toBeGreaterThanOrEqual(before - 1000)
    expect(Date.parse(written.setAt)).toBeLessThanOrEqual(Date.now() + 1000)
    expect(h.audit).toHaveBeenCalledWith("admin1", "sms_settings_update", null,
      { section: "hubtel_manual_balance", values: { sms_hubtel_manual_balance: old } },
      { section: "hubtel_manual_balance", values: { sms_hubtel_manual_balance: written } })
    expect(h.invalidate).toHaveBeenCalledOnce()
  })
  it("refuses a missing admin id", async () => {
    expect((await saveSection("", "switch", { featureEnabled: true })).ok).toBe(false)
    expect(h.upserts).toHaveLength(0)
  })
})

describe("getAdminSettings", () => {
  it("rejects when the read fails", async () => {
    h.selectError = { message: "down" }
    await expect(getAdminSettings()).rejects.toThrow()
  })
  it("parses fresh rows", async () => {
    h.oldRows = [{ key: "sms_feature_enabled", value: false }, { key: "sms_activation_fee", value: { amount: 20 } }]
    const r = await getAdminSettings()
    expect(r.settings.featureEnabled).toBe(false)
    expect(r.pricing.activationFee).toBe(20)
  })
  it("garbage pricing falls back to defaults", async () => {
    h.oldRows = [{ key: "sms_activation_fee", value: { amount: "x" } }]
    expect((await getAdminSettings()).pricing).toEqual({ activationFee: 0, welcomeBonusCredits: 0, pricePerCredit: 0.04 })
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
