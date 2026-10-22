import { describe, it, expect } from "vitest"
import { canIssue } from "./key-issue"

const allowedRoles = ["dealer", "admin"]

describe("canIssue", () => {
  it("allows a standard key for an allowed role", () => {
    expect(canIssue({ type: "standard", role: "dealer", allowedRoles })).toEqual({ ok: true })
  })

  it("allows a commission key for an allowed role", () => {
    expect(canIssue({ type: "commission", role: "admin", allowedRoles })).toEqual({ ok: true })
  })

  it("rejects a role that is not in the allowed list with 403", () => {
    const r = canIssue({ type: "standard", role: "user", allowedRoles })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(403)
  })

  it("rejects everyone when the allowed list is empty (fail closed)", () => {
    const r = canIssue({ type: "standard", role: "admin", allowedRoles: [] })
    expect(r).toMatchObject({ ok: false, status: 403 })
  })

  it("rejects sms keys with 400 and the not-available message", () => {
    const r = canIssue({ type: "sms", role: "dealer", allowedRoles })
    expect(r).toEqual({ ok: false, status: 400, message: "SMS keys are not available yet" })
  })

  it("rejects an unknown type with 400", () => {
    const r = canIssue({ type: "bogus", role: "dealer", allowedRoles })
    expect(r).toMatchObject({ ok: false, status: 400 })
  })

  it("checks type validity before role", () => {
    const r = canIssue({ type: "bogus", role: "user", allowedRoles })
    expect(r).toMatchObject({ ok: false, status: 400 })
  })
})
