import { describe, expect, it } from "vitest"
import { funnelSteps, isQuiet, outcomeLabel, readSplit, relativeTime, segmentText, smsCostText, ttbErrorMessage } from "./format"

const NOW = new Date("2026-11-13T12:00:00.000Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const MIN = 60_000

describe("relativeTime", () => {
  it("says Never for null or garbage", () => {
    expect(relativeTime(null, NOW)).toBe("Never")
    expect(relativeTime("nonsense", NOW)).toBe("Never")
  })
  it("scales from seconds to days", () => {
    expect(relativeTime(ago(10_000), NOW)).toBe("just now")
    expect(relativeTime(ago(5 * MIN), NOW)).toBe("5 min ago")
    expect(relativeTime(ago(180 * MIN), NOW)).toBe("3 h ago")
    expect(relativeTime(ago(49 * 60 * MIN), NOW)).toBe("2 d ago")
  })
  it("treats a future time as just now", () => {
    expect(relativeTime(ago(-5 * MIN), NOW)).toBe("just now")
  })
})

describe("isQuiet", () => {
  it("is true when never heard", () => expect(isQuiet(null, NOW, 60)).toBe(true))
  it("is true only when older than the threshold", () => {
    expect(isQuiet(ago(59 * MIN), NOW, 60)).toBe(false)
    expect(isQuiet(ago(61 * MIN), NOW, 60)).toBe(true)
  })
})

describe("funnelSteps", () => {
  it("gives each step as a percentage of the previous one", () => {
    const s = funnelSteps({ texts: 20, prompts: 10, paid: 5, delivered: 4 })
    expect(s.map((x) => x.label)).toEqual(["Texts", "Prompts", "Paid", "Delivered"])
    expect(s.map((x) => x.pct)).toEqual([null, 50, 50, 80])
  })
  it("has no percentage when the previous step is zero", () => {
    expect(funnelSteps({ texts: 0, prompts: 0, paid: 0, delivered: 0 }).map((x) => x.pct)).toEqual([null, null, null, null])
  })
})

describe("readSplit", () => {
  it("splits rules and AI reads", () => {
    expect(readSplit(3, 1)).toBe("Read by rules 75% / AI 25%")
  })
  it("says no reads yet at zero", () => expect(readSplit(0, 0)).toBe("No texts read yet today"))
})

describe("smsCostText", () => {
  it("uses the rate it is given", () => {
    expect(smsCostText(100, 0.0243)).toBe("Reply SMS today: 100 (about GHS 2.43)")
    expect(smsCostText(0, 0.0243)).toBe("Reply SMS today: 0 (about GHS 0.00)")
    expect(smsCostText(10, 0.5)).toBe("Reply SMS today: 10 (about GHS 5.00)")
  })
})

describe("outcomeLabel", () => {
  it("has a human label for known outcomes and a safe fallback", () => {
    expect(outcomeLabel("prompted")).toBe("Payment prompt sent")
    expect(outcomeLabel(null)).toBe("-")
    expect(outcomeLabel("something_new")).toBe("something_new")
  })
})

describe("segmentText", () => {
  it("shows one segment under 160", () => {
    expect(segmentText("hello")).toEqual({ chars: 5, limit: 160, segments: 1, over: false, text: "5 / 160 characters, 1 segment" })
  })
  it("flags a reply over one segment", () => {
    const r = segmentText("a".repeat(161))
    expect(r.over).toBe(true)
    expect(r.segments).toBe(2)
  })
})

describe("ttbErrorMessage", () => {
  it("explains the settings errors", () => {
    expect(ttbErrorMessage("confirm_required")).toMatch(/confirm/i)
    expect(ttbErrorMessage("settings_unavailable")).toMatch(/could not be read/i)
    expect(ttbErrorMessage("rate_limited")).toMatch(/wait/i)
  })
  it("falls back for anything else", () => expect(ttbErrorMessage("zzz")).toBe("Something went wrong. Please try again."))
})
