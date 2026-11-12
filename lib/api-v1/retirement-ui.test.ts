import { describe, it, expect } from "vitest"
import {
  bannerKind, bannerText, formatGhanaDate, isEarlierThanNotice, isoToPicker, isUuid, pickerToIso,
} from "./retirement-ui"

describe("pickerToIso / isoToPicker", () => {
  it("reads the picker as GMT regardless of the machine timezone", () => {
    expect(pickerToIso("2026-11-26T00:00")).toBe("2026-11-26T00:00:00.000Z")
    expect(pickerToIso("2026-07-01T23:30")).toBe("2026-07-01T23:30:00.000Z")
  })
  it("rejects garbage and impossible dates", () => {
    expect(pickerToIso("")).toBeNull()
    expect(pickerToIso("2026-02-31T10:00")).toBeNull()
    expect(pickerToIso("26/11/2026")).toBeNull()
  })
  it("round-trips", () => {
    expect(isoToPicker("2026-11-26T09:05:00.000Z")).toBe("2026-11-26T09:05")
    expect(pickerToIso(isoToPicker("2026-11-26T09:05:00.000Z"))).toBe("2026-11-26T09:05:00.000Z")
    expect(isoToPicker(null)).toBe("")
    expect(isoToPicker("nope")).toBe("")
  })
})

describe("isEarlierThanNotice", () => {
  const now = new Date("2026-11-12T12:00:00.000Z")
  it("flags dates under 14 days away or in the past", () => {
    expect(isEarlierThanNotice("2026-11-20T00:00:00.000Z", now)).toBe(true)
    expect(isEarlierThanNotice("2026-11-01T00:00:00.000Z", now)).toBe(true)
  })
  it("does not flag exactly 14 days or more", () => {
    expect(isEarlierThanNotice("2026-11-26T12:00:00.000Z", now)).toBe(false)
    expect(isEarlierThanNotice("2026-12-31T00:00:00.000Z", now)).toBe(false)
  })
})

describe("banner", () => {
  it("shows nothing without a sunset or without an active key", () => {
    expect(bannerKind({ sunsetAt: null, exempt: false, hasActiveKey: true })).toBe("none")
    expect(bannerKind({ sunsetAt: "2026-11-26T00:00:00.000Z", exempt: false, hasActiveKey: false })).toBe("none")
  })
  it("picks notice vs exempt", () => {
    expect(bannerKind({ sunsetAt: "2026-11-26T00:00:00.000Z", exempt: false, hasActiveKey: true })).toBe("notice")
    expect(bannerKind({ sunsetAt: "2026-11-26T00:00:00.000Z", exempt: true, hasActiveKey: true })).toBe("exempt")
  })
  it("uses the exact texts", () => {
    expect(bannerText("notice", "2026-11-26T00:00:00.000Z")).toBe(
      "API v1 will be retired on 26 Nov 2026, 00:00 GMT. After that your v1 requests will be refused. Create a v2 key below and follow the v2 docs."
    )
    expect(bannerText("exempt", "2026-11-26T00:00:00.000Z")).toBe(
      "API v1 retires on 26 Nov 2026, 00:00 GMT. Your access continues for now; please plan your move to v2."
    )
  })
})

describe("misc", () => {
  it("formats GMT dates", () => expect(formatGhanaDate(new Date("2026-11-26T00:00:00Z"))).toBe("26 Nov 2026, 00:00 GMT"))
  it("validates uuids", () => {
    expect(isUuid("3f2b8c1e-9a4d-4e6b-8c1d-2a3b4c5d6e7f")).toBe(true)
    expect(isUuid("a@b.com")).toBe(false)
  })
})
