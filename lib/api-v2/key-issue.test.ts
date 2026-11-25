import { describe, it, expect } from "vitest"
import { accessSummary, canIssue, isIssuableType, offersSmsKey } from "./key-issue"

const allowedRoles = ["dealer", "admin"]

describe("canIssue", () => {
  const on = { enabled: true, allowedRoles, suspended: false, hasGrant: false, hasApiCapability: true }

  it("allows a standard key for an allowed role", () => {
    expect(canIssue({ ...on, type: "standard", role: "dealer" })).toEqual({ ok: true })
  })

  it("allows a commission key for an allowed role", () => {
    expect(canIssue({ ...on, type: "commission", role: "admin" })).toEqual({ ok: true })
  })

  it("rejects everyone with 503 while v2 is switched off", () => {
    expect(canIssue({ ...on, enabled: false, type: "standard", role: "dealer" })).toEqual({
      ok: false,
      status: 503,
      message: "The v2 API is not open yet, so keys cannot be generated right now",
    })
  })

  it("checks enabled before anything else (bad type, suspended, disallowed role)", () => {
    const r = canIssue({ enabled: false, type: "bogus", role: "user", allowedRoles: [], suspended: true, hasGrant: false, hasApiCapability: false })
    expect(r).toMatchObject({ ok: false, status: 503 })
  })

  it("rejects a role that is not in the allowed list with 403", () => {
    const r = canIssue({ ...on, type: "standard", role: "user" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(403)
  })

  it("rejects everyone when the allowed list is empty (fail closed)", () => {
    const r = canIssue({ ...on, type: "standard", role: "admin", allowedRoles: [] })
    expect(r).toMatchObject({ ok: false, status: 403 })
  })

  it("allows an sms key when the account has SMS access", () => {
    expect(canIssue({ ...on, type: "sms", role: "dealer", hasSmsAccess: true })).toEqual({ ok: true })
  })

  it("rejects an sms key with 403 when the account has no SMS access (or the flag is missing: fail closed)", () => {
    const msg = "SMS isn't enabled for this account type"
    expect(canIssue({ ...on, type: "sms", role: "dealer", hasSmsAccess: false })).toEqual({ ok: false, status: 403, message: msg })
    expect(canIssue({ ...on, type: "sms", role: "dealer" })).toEqual({ ok: false, status: 403, message: msg })
  })

  it("only consults hasSmsAccess for sms (standard/commission unaffected)", () => {
    expect(canIssue({ ...on, type: "standard", role: "dealer", hasSmsAccess: false })).toEqual({ ok: true })
    expect(canIssue({ ...on, type: "commission", role: "dealer", hasSmsAccess: false })).toEqual({ ok: true })
  })

  it("sms still obeys enabled, suspension and role before the access check", () => {
    expect(canIssue({ ...on, enabled: false, type: "sms", role: "dealer", hasSmsAccess: true })).toMatchObject({ status: 503 })
    expect(canIssue({ ...on, type: "sms", role: "dealer", suspended: true, hasSmsAccess: true })).toMatchObject({ status: 403, message: "This account is suspended" })
    expect(canIssue({ ...on, type: "sms", role: "user", hasSmsAccess: true })).toMatchObject({ status: 403, message: "Your account is not eligible for API keys" })
  })

  it("isIssuableType accepts sms and still rejects unknown types", () => {
    expect(isIssuableType("sms")).toBe(true)
    expect(isIssuableType("standard")).toBe(true)
    expect(isIssuableType("bogus")).toBe(false)
  })

  it("rejects an unknown type with 400", () => {
    const r = canIssue({ ...on, type: "bogus", role: "dealer" })
    expect(r).toMatchObject({ ok: false, status: 400 })
  })

  it("checks type validity before role (after enabled)", () => {
    const r = canIssue({ ...on, type: "bogus", role: "user" })
    expect(r).toMatchObject({ ok: false, status: 400 })
  })

  it("rejects a suspended user with 403 even when the role is allowed", () => {
    expect(canIssue({ ...on, type: "standard", role: "dealer", suspended: true })).toEqual({
      ok: false,
      status: 403,
      message: "This account is suspended",
    })
  })

  it("still checks type before suspension (after enabled)", () => {
    const r = canIssue({ ...on, type: "bogus", role: "dealer", suspended: true })
    expect(r).toMatchObject({ ok: false, status: 400 })
  })

  it("checks suspension before role", () => {
    const r = canIssue({ ...on, type: "standard", role: "user", suspended: true })
    expect(r).toMatchObject({ ok: false, status: 403, message: "This account is suspended" })
  })
})

describe("canIssue with a grant", () => {
  const base = { enabled: true, allowedRoles, suspended: false, hasGrant: true, hasApiCapability: false }
  it("a grant satisfies both the role and the capability requirement", () => {
    expect(canIssue({ ...base, type: "standard", role: "user" })).toEqual({ ok: true })
  })
  it("an allowed role without the capability and without a grant is refused", () => {
    expect(canIssue({ ...base, hasGrant: false, type: "standard", role: "dealer" })).toMatchObject({ ok: false, status: 403 })
  })
  it("a grant never beats disabled or suspended", () => {
    expect(canIssue({ ...base, enabled: false, type: "standard", role: "user" })).toMatchObject({ status: 503 })
    expect(canIssue({ ...base, suspended: true, type: "standard", role: "user" })).toMatchObject({ status: 403, message: "This account is suspended" })
  })
  it("a grant plus sms with no SMS account is refused", () => {
    expect(canIssue({ ...base, type: "sms", role: "user", hasSmsAccess: false })).toMatchObject({ ok: false, status: 403, message: "SMS isn't enabled for this account type" })
    expect(canIssue({ ...base, type: "sms", role: "user", hasSmsAccess: true })).toEqual({ ok: true })
  })
})

describe("accessSummary", () => {
  const base = { role: "dealer", suspended: false, enabled: true, allowedRoles, hasGrant: false, hasApiCapability: true }

  it("returns ok when enabled, not suspended and the role is allowed", () => {
    expect(accessSummary(base)).toEqual({ canGenerate: true, reason: "ok" })
  })

  it("reports disabled first, even for a suspended user with a disallowed role", () => {
    expect(accessSummary({ ...base, enabled: false, suspended: true, role: "user" })).toEqual({
      canGenerate: false,
      reason: "disabled",
    })
  })

  it("reports suspended before role_not_allowed", () => {
    expect(accessSummary({ ...base, suspended: true, role: "user" })).toEqual({
      canGenerate: false,
      reason: "suspended",
    })
  })

  it("reports role_not_allowed when the role is not in the allowed list", () => {
    expect(accessSummary({ ...base, role: "user" })).toEqual({ canGenerate: false, reason: "role_not_allowed" })
  })

  it("fails closed with an empty allowed list", () => {
    expect(accessSummary({ ...base, role: "admin", allowedRoles: [] })).toEqual({
      canGenerate: false,
      reason: "role_not_allowed",
    })
  })
})

describe("accessSummary with a grant or capability", () => {
  const base = { role: "user", suspended: false, enabled: true, allowedRoles, hasGrant: false, hasApiCapability: false }
  it("a grant is ok without the capability", () => {
    expect(accessSummary({ ...base, hasGrant: true })).toEqual({ canGenerate: true, reason: "ok" })
  })
  it("a user lacking the capability with no grant gets role_not_allowed even for an allowed role", () => {
    expect(accessSummary({ ...base, role: "dealer" })).toEqual({ canGenerate: false, reason: "role_not_allowed" })
  })
  it("a grant never beats disabled or suspended", () => {
    expect(accessSummary({ ...base, hasGrant: true, enabled: false })).toEqual({ canGenerate: false, reason: "disabled" })
    expect(accessSummary({ ...base, hasGrant: true, suspended: true })).toEqual({ canGenerate: false, reason: "suspended" })
  })
})

describe("offersSmsKey", () => {
  it("offers SMS only when generation is open and the access GET reported smsAvailable", () => {
    expect(offersSmsKey(true, true)).toBe(true)
    expect(offersSmsKey(true, false)).toBe(false)
    expect(offersSmsKey(true, undefined)).toBe(false)
    expect(offersSmsKey(false, true)).toBe(false)
  })
})
