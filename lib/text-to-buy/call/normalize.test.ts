import { describe, expect, it } from "vitest"
import { normalizeCaller } from "./normalize"

describe("normalizeCaller", () => {
  it.each([
    ["0551234567", "0551234567"],
    ["+233551234567", "0551234567"],
    ["233551234567", "0551234567"],
    [" 0551234567 ", "0551234567"],
    ["551234567", "0551234567"], // 9 digits: the same as the SMS webhook's customerPhone
    ["0123456789", null], // invalid prefix
    ["MTN", null],
    ["+447700900123", null],
    ["", null],
    ["055 123 4567", null], // only digits with an optional leading +
    ["0551234", null],
    ["*123#", null],
  ])("%j -> %j", (raw, want) => {
    expect(normalizeCaller(raw)).toBe(want)
  })
  it("is null for a non-string", () => {
    expect(normalizeCaller(undefined as unknown as string)).toBeNull()
  })
})
