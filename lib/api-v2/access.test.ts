import { describe, it, expect } from "vitest"
import { extractKey, decideAccess, type AccessInput } from "./access"

function headers(h: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (name: string) => lower[name.toLowerCase()] ?? null }
}

describe("extractKey", () => {
  it("reads a raw Authorization value", () => {
    expect(extractKey(headers({ Authorization: "dg2_live_ab12" }))).toBe("dg2_live_ab12")
  })
  it("reads a Bearer Authorization value", () => {
    expect(extractKey(headers({ Authorization: "Bearer dg2_live_ab12" }))).toBe("dg2_live_ab12")
  })
  it("reads X-API-Key", () => {
    expect(extractKey(headers({ "X-API-Key": "dg2_live_ab12" }))).toBe("dg2_live_ab12")
  })
  it("trims surrounding spaces", () => {
    expect(extractKey(headers({ Authorization: "  dg2_live_ab12  " }))).toBe("dg2_live_ab12")
  })
  it("returns null for empty, whitespace, bare Bearer and oversize values", () => {
    expect(extractKey(headers({}))).toBeNull()
    expect(extractKey(headers({ Authorization: "" }))).toBeNull()
    expect(extractKey(headers({ Authorization: "   " }))).toBeNull()
    expect(extractKey(headers({ Authorization: "Bearer " }))).toBeNull()
    expect(extractKey(headers({ Authorization: "x".repeat(513) }))).toBeNull()
  })
  it("prefers Authorization over X-API-Key", () => {
    expect(
      extractKey(headers({ Authorization: "Bearer dg2_live_aa", "X-API-Key": "dg2_live_bb" }))
    ).toBe("dg2_live_aa")
  })
})

describe("decideAccess", () => {
  const good: AccessInput = {
    keyStatus: "active",
    keyType: "standard",
    requiredType: "standard",
    configEnabled: true,
    allowedRoles: ["dealer"],
    userRole: "dealer",
  }

  it("allows when everything is right", () => {
    expect(decideAccess(good)).toEqual({ ok: true })
  })
  it("returns 503 first when the config is disabled", () => {
    const r = decideAccess({ ...good, configEnabled: false })
    expect(r).toMatchObject({ ok: false, status: 503 })
  })
  it("rejects pending keys", () => {
    expect(decideAccess({ ...good, keyStatus: "pending" })).toMatchObject({ ok: false, status: 403 })
  })
  it("rejects revoked keys", () => {
    expect(decideAccess({ ...good, keyStatus: "revoked" })).toMatchObject({ ok: false, status: 403 })
  })
  it("rejects the wrong key type and names the required type", () => {
    const r = decideAccess({ ...good, keyType: "sms", requiredType: "commission" })
    expect(r).toMatchObject({ ok: false, status: 403 })
    if (!r.ok) expect(r.message).toContain("commission")
  })
  it("rejects roles that are not allowed", () => {
    expect(decideAccess({ ...good, userRole: "user" })).toMatchObject({ ok: false, status: 403 })
  })
})
