import { describe, it, expect } from "vitest"
import { pauseCopy, pauseReasonOk, parseDevParam, developerBadges, SEARCH_DEBOUNCE_MS, pauseErrorText } from "./developers-view"

const UID = "11111111-1111-4111-8111-111111111111"

describe("pauseCopy", () => {
  it("pause names the effect: every key blocked, nothing revoked, reversible; needs a reason", () => {
    const c = pauseCopy(true)
    expect(c.title).toMatch(/Pause/)
    expect(c.body).toMatch(/blocks every v2 key for this person/i)
    // review I1: the pause is enforced on v2 only; the copy must not promise more
    expect(c.body).toMatch(/Legacy v1 keys are not affected/i)
    expect(c.body).toMatch(/nothing is revoked/i)
    expect(c.body).toMatch(/reversible/i)
    expect(c.needsReason).toBe(true)
  })
  it("unpause: no reason required", () => {
    const c = pauseCopy(false)
    expect(c.title).toMatch(/Unpause|Resume/)
    expect(c.needsReason).toBe(false)
  })
})

describe("pauseReasonOk", () => {
  it("3-200 characters after trimming", () => {
    expect(pauseReasonOk("ab")).toBe(false)
    expect(pauseReasonOk("  abc  ")).toBe(true)
    expect(pauseReasonOk("x".repeat(200))).toBe(true)
    expect(pauseReasonOk("x".repeat(201))).toBe(false)
  })
})

describe("parseDevParam", () => {
  it("?dev=<uuid> opens that profile; an invalid value is ignored", () => {
    expect(parseDevParam(UID)).toBe(UID)
    expect(parseDevParam(UID.toUpperCase())).toBe(UID)
    expect(parseDevParam("<script>")).toBeNull()
    expect(parseDevParam(null)).toBeNull()
    expect(parseDevParam("")).toBeNull()
  })
})

describe("developerBadges", () => {
  it("PAUSED and grant badges carry text, not colour alone", () => {
    expect(developerBadges({ paused: true, granted: true })).toEqual([
      { label: "PAUSED", tone: "red" },
      { label: "API access granted", tone: "primary" },
    ])
    expect(developerBadges({ paused: false, granted: false })).toEqual([])
  })
})

describe("misc", () => {
  it("search waits 300 ms; route errors are shown, never swallowed", () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(300)
    expect(pauseErrorText(404, "Not found.")).toMatch(/not found/i)
    expect(pauseErrorText(409, null)).toMatch(/changed/i)
    expect(pauseErrorText(0, null)).toMatch(/network/i)
    expect(pauseErrorText(500, "Something went wrong. Please try again.")).toBe("Something went wrong. Please try again.")
  })
})
