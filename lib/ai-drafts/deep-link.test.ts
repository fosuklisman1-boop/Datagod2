import { describe, it, expect } from "vitest"
import { parseDraftParam, cardPushBody } from "./deep-link"

const ID = "11111111-1111-4111-8111-111111111111"

describe("parseDraftParam", () => {
  it("reads a uuid from the query string", () => {
    expect(parseDraftParam(`?draft=${ID}`)).toBe(ID)
    expect(parseDraftParam(`?x=1&draft=${ID}`)).toBe(ID)
  })
  it("rejects missing or malformed ids", () => {
    expect(parseDraftParam("")).toBeNull()
    expect(parseDraftParam("?draft=abc")).toBeNull()
    expect(parseDraftParam(`?draft=${ID}x`)).toBeNull()
  })
})

describe("cardPushBody", () => {
  it("uses the title and appends count and total", () => {
    expect(cardPushBody({ title: "Confirm withdrawals", count: 3, total_ghs: 450 })).toBe("Confirm withdrawals (3, GHS 450)")
  })
  it("falls back safely and caps at 120 chars", () => {
    expect(cardPushBody({})).toBe("A prepared action is waiting")
    expect(cardPushBody({ title: "x".repeat(300) }).length).toBe(120)
  })
})
