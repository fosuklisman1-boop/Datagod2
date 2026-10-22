import { describe, it, expect } from "vitest"
import { initialStatus, applyAction, parseConfigUpdate, V2_ROLES } from "./lifecycle"

describe("initialStatus", () => {
  it("live keys start pending, test keys start active", () => {
    expect(initialStatus("live")).toBe("pending")
    expect(initialStatus("test")).toBe("active")
  })
})

describe("applyAction", () => {
  it("approves pending keys", () => {
    expect(applyAction("pending", "approve")).toEqual({ ok: true, to: "active" })
  })
  it("revokes active and pending keys", () => {
    expect(applyAction("active", "revoke")).toEqual({ ok: true, to: "revoked" })
    expect(applyAction("pending", "revoke")).toEqual({ ok: true, to: "revoked" })
  })
  it("refuses invalid transitions", () => {
    expect(applyAction("revoked", "approve").ok).toBe(false)
    expect(applyAction("revoked", "revoke").ok).toBe(false)
    expect(applyAction("active", "approve").ok).toBe(false)
  })
})

describe("parseConfigUpdate", () => {
  it("V2_ROLES includes admin", () => {
    expect(V2_ROLES.includes("admin")).toBe(true)
  })
  it("accepts enabled", () => {
    expect(parseConfigUpdate({ enabled: true })).toEqual({ ok: true, value: { enabled: true } })
  })
  it("accepts known roles and rejects unknown ones", () => {
    const known = [V2_ROLES[0], V2_ROLES[1]]
    expect(parseConfigUpdate({ allowed_roles: known })).toEqual({
      ok: true,
      value: { allowed_roles: known },
    })
    expect(parseConfigUpdate({ allowed_roles: [V2_ROLES[0], "nope"] }).ok).toBe(false)
  })
  it("accepts an empty role list (nobody allowed)", () => {
    expect(parseConfigUpdate({ allowed_roles: [] })).toEqual({
      ok: true,
      value: { allowed_roles: [] },
    })
  })
  it("rejects wrong types and empty updates", () => {
    expect(parseConfigUpdate({ enabled: "yes" }).ok).toBe(false)
    expect(parseConfigUpdate({}).ok).toBe(false)
    expect(parseConfigUpdate(null).ok).toBe(false)
    expect(parseConfigUpdate({ allowed_roles: "dealer" }).ok).toBe(false)
  })
})
