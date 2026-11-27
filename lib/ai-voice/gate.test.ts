import { describe, it, expect } from "vitest"
import { checkCallCaps, endUserIdFor } from "./gate"
import { DEFAULT_VOICE_SETTINGS } from "./settings"

const S = DEFAULT_VOICE_SETTINGS

describe("checkCallCaps", () => {
  it("admin is always ok", () => {
    expect(checkCallCaps("admin", S, { mineToday: 999, visitorsToday: 999 })).toEqual({ ok: true })
  })
  it("dashboard at its cap -> daily_cap", () => {
    expect(checkCallCaps("dashboard", S, { mineToday: 5, visitorsToday: 0 })).toEqual({ ok: false, reason: "daily_cap" })
  })
  it("public with the visitor total reached -> visitor_cap", () => {
    expect(checkCallCaps("public", S, { mineToday: 0, visitorsToday: 30 })).toEqual({ ok: false, reason: "visitor_cap" })
  })
  it("storefront just under the visitor total -> ok", () => {
    expect(checkCallCaps("storefront", S, { mineToday: 0, visitorsToday: 29 })).toEqual({ ok: true })
  })
  it("dashboard ignores visitorsToday", () => {
    expect(checkCallCaps("dashboard", S, { mineToday: 0, visitorsToday: 500 })).toEqual({ ok: true })
  })
  it("own cap wins over visitor cap", () => {
    expect(checkCallCaps("public", S, { mineToday: 1, visitorsToday: 30 })).toEqual({ ok: false, reason: "daily_cap" })
  })
})

describe("endUserIdFor", () => {
  it("signed-in user", () => {
    expect(endUserIdFor("abc-123", null, "salt")).toBe("u_abc-123")
  })
  it("device hash format and stability", () => {
    const a = endUserIdFor(null, "dev-1", "salt")
    expect(a).toMatch(/^d_[0-9a-f]{32}$/)
    expect(endUserIdFor(null, "dev-1", "salt")).toBe(a)
    expect(endUserIdFor(null, "dev-2", "salt")).not.toBe(a)
  })
  it("always a valid Nuance end_user_id", () => {
    for (const id of [endUserIdFor("abc-123", null, "s"), endUserIdFor(null, "x", "s"), endUserIdFor(null, null, "s")]) {
      expect(id).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/)
    }
  })
})
