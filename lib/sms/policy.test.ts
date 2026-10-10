import { describe, it, expect, vi } from "vitest"

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
import { evaluateSendPolicy, isOwnDomain, type PolicyInput } from "./policy"
import { DEFAULT_SMS_SETTINGS } from "./platform-settings"

function input(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    account: { audience: "shop_owner", status: "active", mode: "platform", reviewHold: false },
    settings: DEFAULT_SMS_SETTINGS,
    ownDomains: ["datagod.store", "kingsdata.com"],
    usage: { sendsLastHour: 0, recipientsLast24h: 0 },
    sender: { kind: "platform", name: null, kycFree: false },
    recipientCount: 10,
    message: "Hello, your data is ready",
    ...over,
  }
}
const withSettings = (s: Partial<typeof DEFAULT_SMS_SETTINGS>) => ({ ...DEFAULT_SMS_SETTINGS, ...s })

describe("evaluateSendPolicy — gates", () => {
  it("allows a clean platform send", () => {
    expect(evaluateSendPolicy(input())).toMatchObject({ decision: "allow", code: "OK", flags: [] })
  })
  it("master switch off → unavailable", () => {
    expect(evaluateSendPolicy(input({ settings: withSettings({ featureEnabled: false }) })).code).toBe("FEATURE_DISABLED")
  })
  it("role not allowed → reject", () => {
    const r = evaluateSendPolicy(input({ account: { audience: "dealer", status: "active", mode: "platform", reviewHold: false } }))
    expect(r).toMatchObject({ decision: "reject", code: "ROLE_NOT_ALLOWED" })
  })
  it("admin audience is always allowed", () => {
    const r = evaluateSendPolicy(input({ account: { audience: "admin", status: "active", mode: "business", reviewHold: false }, settings: withSettings({ allowedRoles: [] }) }))
    expect(r.decision).toBe("allow")
  })
  it("suspended → reject", () => {
    expect(evaluateSendPolicy(input({ account: { audience: "shop_owner", status: "suspended", mode: "platform", reviewHold: false } })).code).toBe("SUSPENDED")
  })
})

describe("evaluateSendPolicy — senders", () => {
  it("platform mode: own kyc_free ok", () => {
    expect(evaluateSendPolicy(input({ sender: { kind: "own", name: "KINGS", kycFree: true } })).decision).toBe("allow")
  })
  it("platform mode: own non-kyc_free rejected", () => {
    expect(evaluateSendPolicy(input({ sender: { kind: "own", name: "KINGS2", kycFree: false } })).code).toBe("SENDER_NOT_ALLOWED")
  })
  it("platform mode: pool rejected", () => {
    expect(evaluateSendPolicy(input({ sender: { kind: "pool", name: "ALERTS", kycFree: false } })).code).toBe("SENDER_NOT_ALLOWED")
  })
  it("business mode: any own and pool ok", () => {
    const acct = { audience: "shop_owner", status: "active", mode: "business" as const, reviewHold: false }
    expect(evaluateSendPolicy(input({ account: acct, sender: { kind: "own", name: "X", kycFree: false } })).decision).toBe("allow")
    expect(evaluateSendPolicy(input({ account: acct, sender: { kind: "pool", name: "ALERTS", kycFree: false } })).decision).toBe("allow")
  })
})

describe("evaluateSendPolicy — caps", () => {
  it("per-send cap", () => {
    const r = evaluateSendPolicy(input({ recipientCount: 301 }))
    expect(r.code).toBe("CAP_PER_SEND")
    expect(r.reason).toContain("300")
  })
  it("per-hour cap counts this send", () => {
    expect(evaluateSendPolicy(input({ usage: { sendsLastHour: 19, recipientsLast24h: 0 } })).decision).toBe("allow")
    expect(evaluateSendPolicy(input({ usage: { sendsLastHour: 20, recipientsLast24h: 0 } })).code).toBe("CAP_PER_HOUR")
  })
  it("per-day cap includes this send's recipients", () => {
    expect(evaluateSendPolicy(input({ recipientCount: 10, usage: { sendsLastHour: 0, recipientsLast24h: 490 } })).decision).toBe("allow")
    expect(evaluateSendPolicy(input({ recipientCount: 11, usage: { sendsLastHour: 0, recipientsLast24h: 490 } })).code).toBe("CAP_PER_DAY")
  })
  it("business caps are separate", () => {
    const acct = { audience: "shop_owner", status: "active", mode: "business" as const, reviewHold: false }
    expect(evaluateSendPolicy(input({ account: acct, recipientCount: 900 })).decision).toBe("allow")
  })
})

describe("evaluateSendPolicy — platform content", () => {
  it("platform blocked keyword → block + fraud flag", () => {
    const r = evaluateSendPolicy(input({ settings: withSettings({ blockedKeywords: ["loan"] }), message: "Quick loan today" }))
    expect(r).toMatchObject({ decision: "block", code: "CONTENT_BLOCKED" })
    expect(r.flags).toEqual([{ severity: "fraud", reason: 'blocked keyword: "loan"', matched: "loan" }])
  })
  it("built-in phishing → block + fraud flag", () => {
    const r = evaluateSendPolicy(input({ message: "Send your PIN now" }))
    expect(r.code).toBe("CONTENT_BLOCKED")
    expect(r.flags[0].severity).toBe("fraud")
  })
  it("own-domain store slugs with digits are not treated as lookalikes", () => {
    expect(evaluateSendPolicy(input({ message: "Order at kofi233.datagod.store/x" })).decision).toBe("allow")
  })
  it("own domain links allowed incl. subdomains and custom domains", () => {
    expect(evaluateSendPolicy(input({ message: "Shop at kings.datagod.store/x or https://kingsdata.com" })).decision).toBe("allow")
  })
  it("other links → block without a flag", () => {
    const r = evaluateSendPolicy(input({ message: "See example.com" }))
    expect(r).toMatchObject({ decision: "block", code: "LINK_NOT_ALLOWED", flags: [] })
    expect(r.reason).toContain("example.com")
  })
  it("shortener → block + fraud flag", () => {
    const r = evaluateSendPolicy(input({ message: "tap bit.ly/x" }))
    expect(r.code).toBe("CONTENT_BLOCKED")
    expect(r.flags[0]).toMatchObject({ severity: "fraud", matched: "bit.ly" })
  })
})

describe("evaluateSendPolicy — business content", () => {
  const acct = { audience: "shop_owner", status: "active", mode: "business" as const, reviewHold: false }
  it("business blocked keyword → block + fraud", () => {
    const r = evaluateSendPolicy(input({ account: acct, settings: withSettings({ businessBlockedKeywords: ["casino"] }), message: "casino night" }))
    expect(r.code).toBe("CONTENT_BLOCKED")
  })
  it("platform keyword list does not apply to business", () => {
    const r = evaluateSendPolicy(input({ account: acct, settings: withSettings({ blockedKeywords: ["promo"] }), message: "big promo" }))
    expect(r.decision).toBe("allow")
  })
  it("flagged keyword → allow + info flag", () => {
    const r = evaluateSendPolicy(input({ account: acct, settings: withSettings({ businessFlaggedKeywords: ["bonus"] }), message: "Bonus inside" }))
    expect(r.decision).toBe("allow")
    expect(r.flags).toEqual([{ severity: "info", reason: 'flagged keyword: "bonus"', matched: "bonus" }])
  })
  it("normal external links allowed", () => {
    expect(evaluateSendPolicy(input({ account: acct, message: "see example.com" })).flags).toEqual([])
  })
  it("suspicious link → info flag unless allow-listed", () => {
    expect(evaluateSendPolicy(input({ account: acct, message: "bit.ly/x" })).flags[0]).toMatchObject({ severity: "info", matched: "bit.ly" })
    expect(evaluateSendPolicy(input({ account: acct, settings: withSettings({ businessAllowedDomains: ["bit.ly"] }), message: "bit.ly/x" })).flags).toEqual([])
  })
})

describe("evaluateSendPolicy — review hold", () => {
  it("passing sends from a held account → hold, keeping flags", () => {
    const r = evaluateSendPolicy(input({ account: { audience: "shop_owner", status: "active", mode: "platform", reviewHold: true } }))
    expect(r).toMatchObject({ decision: "hold", code: "REVIEW_HOLD" })
  })
  it("a block still wins over hold", () => {
    const r = evaluateSendPolicy(input({ account: { audience: "shop_owner", status: "active", mode: "platform", reviewHold: true }, message: "example.com" }))
    expect(r.decision).toBe("block")
  })
})

describe("isOwnDomain", () => {
  it("matches exact, subdomain and www", () => {
    expect(isOwnDomain("datagod.store", ["datagod.store"])).toBe(true)
    expect(isOwnDomain("a.b.datagod.store", ["datagod.store"])).toBe(true)
    expect(isOwnDomain("www.kingsdata.com", ["kingsdata.com"])).toBe(true)
    expect(isOwnDomain("notdatagod.store", ["datagod.store"])).toBe(false)
  })
})
