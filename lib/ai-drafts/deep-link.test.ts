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

import { parseReapproveParams } from "./deep-link"

describe("parseReapproveParams", () => {
  it("returns the task id when ai=reapprove and task is a uuid", () => {
    expect(parseReapproveParams(`?ai=reapprove&task=${ID}`)).toEqual({ taskId: ID })
  })
  it("returns taskId null for reapprove without a valid task", () => {
    expect(parseReapproveParams("?ai=reapprove")).toEqual({ taskId: null })
    expect(parseReapproveParams("?ai=reapprove&task=abc")).toEqual({ taskId: null })
  })
  it("returns null when not a reapprove link", () => {
    expect(parseReapproveParams("")).toBeNull()
    expect(parseReapproveParams(`?task=${ID}`)).toBeNull()
    expect(parseReapproveParams(`?ai=other&task=${ID}`)).toBeNull()
  })
})
