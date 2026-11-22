import { describe, it, expect } from "vitest"
import { initialStatus, applyAction, parseConfigUpdate } from "./lifecycle"

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
  const active = ["user", "sub_agent", "dealer", "admin", "reseller"]
  it("accepts enabled", () => {
    expect(parseConfigUpdate({ enabled: true }, active)).toEqual({ ok: true, value: { enabled: true } })
  })
  it("accepts an active custom role and refuses an unknown one", () => {
    expect(parseConfigUpdate({ allowed_roles: ["user", "reseller"] }, active)).toEqual({
      ok: true,
      value: { allowed_roles: ["user", "reseller"] },
    })
    expect(parseConfigUpdate({ allowed_roles: ["user", "nope"] }, active)).toEqual({ ok: false, error: "Unknown role: nope" })
  })
  it("refuses a role that is not in the supplied list (an archived custom role)", () => {
    expect(parseConfigUpdate({ allowed_roles: ["old_tier"] }, active).ok).toBe(false)
  })
  it("dedupes roles", () => {
    expect(parseConfigUpdate({ allowed_roles: ["user", "user"] }, active)).toEqual({ ok: true, value: { allowed_roles: ["user"] } })
  })
  it("accepts an empty role list (nobody allowed)", () => {
    expect(parseConfigUpdate({ allowed_roles: [] }, [])).toEqual({ ok: true, value: { allowed_roles: [] } })
  })
  it("rejects wrong types and empty updates", () => {
    expect(parseConfigUpdate({ enabled: "yes" }, active).ok).toBe(false)
    expect(parseConfigUpdate({}, active).ok).toBe(false)
    expect(parseConfigUpdate(null, active).ok).toBe(false)
    expect(parseConfigUpdate({ allowed_roles: "dealer" }, active).ok).toBe(false)
  })
  describe("approval_whatsapp", () => {
    it("normalises a number to digits", () => {
      expect(parseConfigUpdate({ approval_whatsapp: "0559919037" }, active)).toEqual({
        ok: true,
        value: { approval_whatsapp: "233559919037" },
      })
    })
    it("an explicit empty value clears (null)", () => {
      expect(parseConfigUpdate({ approval_whatsapp: "" }, active)).toEqual({ ok: true, value: { approval_whatsapp: null } })
      expect(parseConfigUpdate({ approval_whatsapp: null }, active)).toEqual({ ok: true, value: { approval_whatsapp: null } })
    })
    it("an absent property leaves the contact alone (never clears)", () => {
      const r = parseConfigUpdate({ enabled: true, allowed_roles: ["user"] }, active)
      expect(r).toEqual({ ok: true, value: { enabled: true, allowed_roles: ["user"] } })
      if (r.ok) expect("approval_whatsapp" in r.value).toBe(false)
    })
    it("refuses an invalid contact", () => {
      expect(parseConfigUpdate({ approval_whatsapp: "https://evil.example/x" }, active).ok).toBe(false)
    })
  })
})
