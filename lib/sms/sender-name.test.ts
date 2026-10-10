import { describe, it, expect } from "vitest"
import { normalizeSenderName, validateSenderName } from "./sender-name"

const PROTECTED = ["MTN", "TELECEL", "MOBILE MONEY", "GRA", "DATAGOD", "ECG", "GLO"]

describe("normalizeSenderName", () => {
  it("trims, collapses spaces, uppercases", () => expect(normalizeSenderName("  kings   shop ")).toBe("KINGS SHOP"))
})

describe("validateSenderName", () => {
  const ok = (raw: string) => validateSenderName(raw, PROTECTED)
  it("accepts a normal name", () => expect(ok("Kings Shop")).toEqual({ ok: true, name: "KINGS SHOP" }))
  it("rejects shorter than 3", () => expect(ok("AB").ok).toBe(false))
  it("rejects longer than 11", () => expect(ok("ABCDEFGHIJKL").ok).toBe(false))
  it("rejects symbols", () => expect(ok("KINGS-SHOP").ok).toBe(false))
  it("requires a letter", () => expect(ok("12345").ok).toBe(false))
  it("blocks a protected name inside a word", () => expect(ok("MYTELECELGH").ok).toBe(false))
  it("blocks a protected name ignoring spaces", () => expect(ok("TELE CEL GH").ok).toBe(false))
  it("blocks multi-word protected names written together", () => expect(ok("MOBILEMONEY").ok).toBe(false))
  it("short protected names only match whole words", () => {
    expect(ok("GRACE SHOP").ok).toBe(true)
    expect(ok("GRA ALERTS").ok).toBe(false)
    expect(ok("GRA").ok).toBe(false)
  })
  it("vowel-less short names (MTN, ECG) match as substrings", () => {
    expect(ok("MYMTNDEALS").ok).toBe(false)
    expect(ok("MTNGH").ok).toBe(false)
    expect(ok("ECG PAY").ok).toBe(false)
    expect(ok("ECGPAY").ok).toBe(false)
  })
  it("short names with a vowel stay whole-word only", () => {
    expect(ok("GLORY").ok).toBe(true)
    expect(ok("GLO DATA").ok).toBe(false)
  })
  it("reason names the protected brand", () => {
    const r = validateSenderName("DATAGOD GH", PROTECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("DATAGOD")
  })
})
