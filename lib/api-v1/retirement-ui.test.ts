import { describe, it, expect } from "vitest"
import {
  buildRetirementPutBody,
  bannerKind, bannerText, topNonExemptStraggler, formatGhanaDate, isEarlierThanNotice, isoToPicker, isUuid, pickerToIso,
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

describe("bannerText variants", () => {
  const SUN = "2026-11-26T00:00:00.000Z"
  const before = new Date("2026-11-20T00:00:00.000Z")
  const after = new Date("2026-11-27T00:00:00.000Z")
  it("post-sunset non-exempt never says 'will be retired'", () => {
    expect(bannerText("notice", SUN, { now: after })).toBe(
      "API v1 was retired on 26 Nov 2026, 00:00 GMT. Your v1 requests are now refused. Create a v2 key below and follow the v2 docs."
    )
  })
  it("v2 section unavailable swaps the pointer, pre and post sunset", () => {
    expect(bannerText("notice", SUN, { now: before, v2Open: false })).toBe(
      "API v1 will be retired on 26 Nov 2026, 00:00 GMT. After that your v1 requests will be refused. See the v2 docs to move over."
    )
    expect(bannerText("notice", SUN, { now: after, v2Open: false })).toBe(
      "API v1 was retired on 26 Nov 2026, 00:00 GMT. Your v1 requests are now refused. See the v2 docs to move over."
    )
  })
  it("exempt text is unchanged by now/v2Open", () => {
    expect(bannerText("exempt", SUN, { now: after, v2Open: false })).toBe(
      "API v1 retires on 26 Nov 2026, 00:00 GMT. Your access continues for now; please plan your move to v2."
    )
  })
})

describe("topNonExemptStraggler", () => {
  const s = (user_id: string, orders_7d: number, exempt = false) => ({ user_id, email: `${user_id}@x.com`, orders_7d, exempt })
  it("picks the non-exempt caller with most orders", () => {
    expect(topNonExemptStraggler([s("a", 3), s("b", 9, true), s("c", 5)])?.user_id).toBe("c")
  })
  it("null when none placed orders or all are exempt", () => {
    expect(topNonExemptStraggler([s("a", 0), s("b", 9, true)])).toBeNull()
    expect(topNonExemptStraggler([])).toBeNull()
  })
})

describe("buildRetirementPutBody", () => {
  it("carries expected_updated_at from the loaded data", () => {
    expect(buildRetirementPutBody("2026-11-26T00:00:00.000Z", ["u1"], "2026-11-12T08:00:00.123456+00:00")).toEqual({
      sunset_at: "2026-11-26T00:00:00.000Z",
      exempt_user_ids: ["u1"],
      expected_updated_at: "2026-11-12T08:00:00.123456+00:00",
    })
  })
})

describe("misc", () => {
  it("formats GMT dates", () => expect(formatGhanaDate(new Date("2026-11-26T00:00:00Z"))).toBe("26 Nov 2026, 00:00 GMT"))
  it("validates uuids", () => {
    expect(isUuid("3f2b8c1e-9a4d-4e6b-8c1d-2a3b4c5d6e7f")).toBe(true)
    expect(isUuid("a@b.com")).toBe(false)
  })
})
