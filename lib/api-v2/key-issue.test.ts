import { describe, it, expect } from "vitest"
import { accessSummary, canIssue, legacyDefaultOpen } from "./key-issue"

const allowedRoles = ["dealer", "admin"]

describe("canIssue", () => {
  const on = { enabled: true, allowedRoles, suspended: false }

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
    const r = canIssue({ enabled: false, type: "bogus", role: "user", allowedRoles: [], suspended: true })
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

  it("rejects sms keys with 400 and the not-available message", () => {
    const r = canIssue({ ...on, type: "sms", role: "dealer" })
    expect(r).toEqual({ ok: false, status: 400, message: "SMS keys are not available yet" })
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

describe("accessSummary", () => {
  const base = { role: "dealer", suspended: false, enabled: true, allowedRoles }

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

describe("legacyDefaultOpen", () => {
  it("opens the legacy v1 section while v2 is not open yet", () => {
    expect(legacyDefaultOpen("disabled")).toBe(true)
  })

  it("opens it while the access state is still loading or failed to load", () => {
    expect(legacyDefaultOpen("loading")).toBe(true)
    expect(legacyDefaultOpen("error")).toBe(true)
  })

  it("keeps it collapsed once v2 is open", () => {
    expect(legacyDefaultOpen("ok")).toBe(false)
    expect(legacyDefaultOpen("suspended")).toBe(false)
    expect(legacyDefaultOpen("role_not_allowed")).toBe(false)
  })
})
