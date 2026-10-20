import { describe, expect, it } from "vitest"
import { checkClientPrice } from "./price-check"

describe("checkClientPrice", () => {
  it("matches within 1 pesewa, including float noise", () => {
    expect(checkClientPrice(5.1, 4.2 + 0.9)).toBe("match")
    expect(checkClientPrice(5.2, 5.21)).toBe("match")
  })

  it("page asking for more than the real price is a stale page, not fraud (2026-10-20 false alarm)", () => {
    expect(checkClientPrice(5.2, 4.2 + 0.9)).toBe("stale")
  })

  it("page asking for less than the real price is flagged", () => {
    expect(checkClientPrice(1, 26.51)).toBe("under")
    expect(checkClientPrice(5.1, 5.2)).toBe("under")
  })

  it("a missing or non-numeric client price is flagged", () => {
    expect(checkClientPrice(Number.NaN, 5)).toBe("under")
    expect(checkClientPrice(undefined as unknown as number, 5)).toBe("under")
  })
})
