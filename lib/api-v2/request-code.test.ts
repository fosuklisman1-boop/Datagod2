import { describe, expect, it, vi } from "vitest"
import { newRequestCode } from "./request-code"

describe("newRequestCode", () => {
  it("matches the format with the default random source", () => {
    for (let i = 0; i < 50; i++) {
      expect(newRequestCode()).toMatch(/^API-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/)
    }
  })
  it("asks for a number below 31 and maps the ends of the range", () => {
    const low = vi.fn(() => 0)
    expect(newRequestCode(low)).toBe("API-222222")
    expect(low).toHaveBeenCalledTimes(6)
    expect(low).toHaveBeenCalledWith(31)
    expect(newRequestCode(() => 30)).toBe("API-ZZZZZZ")
  })
  it("never uses 0, O, 1, I or L", () => {
    for (let n = 0; n < 31; n++) expect(newRequestCode(() => n).slice(4)).not.toMatch(/[01OIL]/)
  })
})
