import { describe, it, expect } from "vitest"
import { costPayload, costFieldText } from "./package-cost-form"

describe("costPayload", () => {
  it("omits the key when the costs failed to load, whatever was typed", () => {
    expect(costPayload(null, "", true)).toEqual({ kind: "omit" })
    expect(costPayload(null, "5", true)).toEqual({ kind: "omit" })
  })
  it("omits the key when the field is untouched", () => {
    expect(costPayload(4.5, "4.5", false)).toEqual({ kind: "omit" })
    expect(costPayload(null, "", false)).toEqual({ kind: "omit" })
    expect(costPayload(null, "   ", false)).toEqual({ kind: "omit" })
    expect(costPayload(4, "4.00", false)).toEqual({ kind: "omit" })
  })
  it("sends null only when the admin cleared a loaded cost", () => {
    expect(costPayload(4.5, "", false)).toEqual({ kind: "set", value: null })
  })
  it("sends the new number when changed (including 0)", () => {
    expect(costPayload(4.5, "6", false)).toEqual({ kind: "set", value: 6 })
    expect(costPayload(null, "0", false)).toEqual({ kind: "set", value: 0 })
  })
  it("flags invalid input", () => {
    expect(costPayload(null, "-1", false).kind).toBe("error")
    expect(costPayload(null, "abc", false).kind).toBe("error")
    expect(costPayload(null, "100000000", false).kind).toBe("error")
  })
})

describe("costFieldText", () => {
  it("prefills the loaded cost or blank", () => {
    expect(costFieldText(4.5)).toBe("4.5")
    expect(costFieldText(null)).toBe("")
    expect(costFieldText(undefined)).toBe("")
  })
})
