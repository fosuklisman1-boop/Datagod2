import { describe, it, expect } from "vitest"
import {
  encodeCursor, decodeCursor, isLine, isOutcome, OUTCOMES, startOfTodayAccra, buildOverview, toAdminMessage, SMS_RATE_GHS,
} from "./admin-view"

const ID = "00000000-0000-4000-8000-000000000001"

describe("cursor", () => {
  it("round-trips, keeping microseconds verbatim", () => {
    for (const at of ["2026-11-13T10:05:00.123456+00:00", "2026-11-13T10:05:00Z", "2026-11-13T10:05:00.5Z"]) {
      expect(decodeCursor(encodeCursor(at, ID))).toEqual({ createdAt: at, id: ID })
    }
  })
  it("garbage, tampered or wrongly shaped cursors decode to null", () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")
    const cases: (string | null)[] = [
      null, "", "not-a-cursor", "!!!", "e30", enc({}), enc([]), enc(["x"]), enc([1, ID]), enc(["2026-11-13T10:05:00Z", 5]),
      enc(["2026-11-13T10:05:00Z", "not-a-uuid"]), enc(["yesterday", ID]), enc(["2026-13-45T10:05:00Z", ID]),
      enc(["2026-11-13T10:05:00Z,id.eq.x", ID]), enc(["2026-11-13T10:05:00+02:00", ID]), enc(["2026-11-13T10:05:00Z", ID, "extra"]),
      "A".repeat(500),
    ]
    for (const c of cases) expect(decodeCursor(c)).toBeNull()
  })
})

describe("validators", () => {
  it("isLine and isOutcome accept only members", () => {
    expect(isLine("main") && isLine("shop")).toBe(true)
    for (const v of ["", "MAIN", "other", null, 1]) expect(isLine(v)).toBe(false)
    for (const o of OUTCOMES) expect(isOutcome(o)).toBe(true)
    for (const v of ["", "toString", "__proto__", "PROMPTED", null]) expect(isOutcome(v)).toBe(false)
    expect(OUTCOMES).toHaveLength(13)
  })
})

describe("startOfTodayAccra", () => {
  it("is 00:00 UTC of the same day", () => {
    expect(startOfTodayAccra(new Date("2026-11-13T23:59:59Z")).toISOString()).toBe("2026-11-13T00:00:00.000Z")
    expect(startOfTodayAccra(new Date("2026-11-13T00:00:00Z")).toISOString()).toBe("2026-11-13T00:00:00.000Z")
  })
})

describe("buildOverview", () => {
  const heard = { main: new Date("2026-11-13T10:00:00Z"), shop: null }
  it("always has both lines, the shop one disabled with zeros, and multiplies replies by the rate", () => {
    const o = buildOverview(
      [{ line: "main", texts: 10, prompts: 4, paid: 3, delivered: 2, replies: 100, aiReads: 2, ruleReads: 8 }],
      heard,
      { enabled: true, number: "0200000100" },
    )
    expect(o.main).toEqual({
      enabled: true, number: "0200000100", lastHeardAt: "2026-11-13T10:00:00.000Z",
      today: { texts: 10, prompts: 4, paid: 3, delivered: 2, replies: 100, aiReads: 2, ruleReads: 8 }, smsCostGhs: 2.43,
    })
    expect(o.shop).toEqual({
      enabled: false, number: "", lastHeardAt: null,
      today: { texts: 0, prompts: 0, paid: 0, delivered: 0, replies: 0, aiReads: 0, ruleReads: 0 }, smsCostGhs: 0,
    })
    expect(SMS_RATE_GHS).toBe(0.0243)
  })
})

describe("toAdminMessage", () => {
  it("maps columns to the response fields and defaults unknowns", () => {
    expect(toAdminMessage({ id: ID, created_at: "t", line: "weird", sender: "0200000101", direction: "out", body: null, read_by: "x", outcome: 5, order_link_id: null, misread: true })).toEqual({
      id: ID, createdAt: "t", line: "main", sender: "0200000101", direction: "out", body: "", readBy: null, outcome: null, orderLinkId: null, misread: true,
    })
  })
})
