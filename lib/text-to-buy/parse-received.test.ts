import { describe, it, expect } from "vitest"
import { parseReceived } from "./parse-received"

const NOW = new Date("2026-11-13T12:00:00.000Z")
const INSTANT = Date.parse("2026-11-13T11:58:30.000Z")
const at = (v: unknown) => parseReceived(v, NOW)?.getTime() ?? null

describe("parseReceived", () => {
  it("reads every accepted form to the same instant", () => {
    expect(at("2026-11-13T11:58:30Z")).toBe(INSTANT)
    expect(at("2026-11-13T11:58:30.000Z")).toBe(INSTANT)
    expect(at("2026-11-13T11:58:30")).toBe(INSTANT) // no timezone = UTC
    expect(at("2026-11-13 11:58:30")).toBe(INSTANT) // UTC
    expect(at("2026-11-13T12:58:30+01:00")).toBe(INSTANT)
    expect(at("1794571110")).toBe(INSTANT) // epoch seconds
    expect(at(1794571110)).toBe(INSTANT)
    expect(at("1794571110000")).toBe(INSTANT) // epoch milliseconds
    expect(at(1794571110000)).toBe(INSTANT)
    expect(at("  2026-11-13 11:58:30  ")).toBe(INSTANT)
  })

  it("returns null for garbage, empty and non-scalar values", () => {
    for (const v of ["", "   ", "yesterday", "13/11/2026", "2026-13-45 99:99:99", "12345", "17945711100", null, undefined, {}, [], true, NaN]) {
      expect(at(v)).toBeNull()
    }
  })

  it("returns null outside 2020-01-01 .. now + 1 day", () => {
    expect(at("2019-12-31T23:59:59Z")).toBeNull()
    expect(at("2020-01-01T00:00:00Z")).not.toBeNull()
    expect(at("2026-11-14T11:59:59Z")).not.toBeNull()
    expect(at("2026-11-14T12:00:01Z")).toBeNull()
    expect(at("1000000000")).toBeNull() // 2001
  })
})
