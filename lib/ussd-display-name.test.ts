import { describe, it, expect } from "vitest"
import { validateUssdDisplayName, BLOCKED_WORDS } from "./ussd-display-name"

describe("validateUssdDisplayName", () => {
  it("rejects an empty string", () => {
    expect(validateUssdDisplayName("")).toEqual({ valid: false, reason: "Name is required" })
  })

  it("rejects a whitespace-only string", () => {
    expect(validateUssdDisplayName("   ")).toEqual({ valid: false, reason: "Name is required" })
  })

  it("accepts an ordinary name", () => {
    expect(validateUssdDisplayName("Kwame Mobile Shop")).toEqual({ valid: true })
  })

  it("accepts a name exactly 30 characters long", () => {
    const name = "A".repeat(30)
    expect(validateUssdDisplayName(name)).toEqual({ valid: true })
  })

  it("rejects a name 31 characters long", () => {
    const name = "A".repeat(31)
    expect(validateUssdDisplayName(name)).toEqual({
      valid: false,
      reason: "Name must be 30 characters or fewer",
    })
  })

  it.each(BLOCKED_WORDS)("rejects the whole word \"%s\" case-insensitively", (word) => {
    const result = validateUssdDisplayName(`Best ${word.toUpperCase()} Shop`)
    expect(result.valid).toBe(false)
  })

  it("passes a name containing a blocked word as a substring without word boundaries (AirtelTigoDeals)", () => {
    expect(validateUssdDisplayName("AirtelTigoDeals")).toEqual({ valid: true })
  })

  it("passes a name containing a blocked word as a substring without word boundaries (Databright Ventures)", () => {
    expect(validateUssdDisplayName("Databright Ventures")).toEqual({ valid: true })
  })

  it("rejects the bare word \"AT\" when it stands alone", () => {
    const result = validateUssdDisplayName("At Express")
    expect(result.valid).toBe(false)
  })
})
