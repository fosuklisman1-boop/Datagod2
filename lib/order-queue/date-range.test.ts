import { describe, it, expect } from "vitest"
import { rangeBoundToIso, isoToLocalParts } from "./date-range"
import { parseQueueParams } from "./params"

describe("rangeBoundToIso", () => {
  it("no date ⇒ null", () => {
    expect(rangeBoundToIso("", "", "from")).toBeNull()
    expect(rangeBoundToIso("", "10:00", "to")).toBeNull()
  })
  it("from with no time is local midnight", () => {
    expect(rangeBoundToIso("2026-11-21", "", "from")).toBe(new Date("2026-11-21T00:00:00").toISOString())
  })
  it("to with no time is the end of that local day", () => {
    expect(rangeBoundToIso("2026-11-21", "", "to")).toBe(new Date("2026-11-21T23:59:59.999").toISOString())
  })
  it("a time is honoured (to covers the whole minute)", () => {
    expect(rangeBoundToIso("2026-11-21", "10:30", "from")).toBe(new Date("2026-11-21T10:30:00").toISOString())
    expect(rangeBoundToIso("2026-11-21", "10:30", "to")).toBe(new Date("2026-11-21T10:30:59.999").toISOString())
  })
  it("bad input ⇒ null", () => {
    expect(rangeBoundToIso("2026-13-45", "", "from")).toBeNull()
  })
  it("output is accepted by the queue API's strict datetime check", () => {
    const from = rangeBoundToIso("2026-11-21", "", "from")!
    const to = rangeBoundToIso("2026-11-21", "", "to")!
    const r = parseQueueParams(new URLSearchParams({ from, to }))
    expect(r.ok).toBe(true)
  })
})

describe("isoToLocalParts", () => {
  it("null ⇒ empty parts", () => {
    expect(isoToLocalParts(null, "from")).toEqual({ date: "", time: "" })
  })
  it("round-trips a from bound with a time", () => {
    expect(isoToLocalParts(rangeBoundToIso("2026-11-21", "10:30", "from"), "from")).toEqual({ date: "2026-11-21", time: "10:30" })
  })
  it("whole-day bounds show no time", () => {
    expect(isoToLocalParts(rangeBoundToIso("2026-11-21", "", "from"), "from")).toEqual({ date: "2026-11-21", time: "" })
    expect(isoToLocalParts(rangeBoundToIso("2026-11-21", "", "to"), "to")).toEqual({ date: "2026-11-21", time: "" })
  })
  it("round-trips a to bound with a time", () => {
    expect(isoToLocalParts(rangeBoundToIso("2026-11-21", "18:05", "to"), "to")).toEqual({ date: "2026-11-21", time: "18:05" })
  })
  it("garbage ⇒ empty parts", () => {
    expect(isoToLocalParts("nope", "to")).toEqual({ date: "", time: "" })
  })
})
