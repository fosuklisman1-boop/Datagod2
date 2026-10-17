import { describe, it, expect } from "vitest"
import {
  applyBuffer, computeEstimate, confirmScreenText, formatDuration, freeze, headlineFor, strengthFor, tick,
  type ChannelOverride,
} from "./compute"

const NOW = "2026-10-17T12:00:00.000Z"
const ago = (seconds: number) => new Date(Date.parse(NOW) - seconds * 1000).toISOString()
const min = (m: number) => m * 60

describe("applyBuffer", () => {
  it("subtracts 5 minutes only from durations over 5 minutes", () => {
    expect(applyBuffer(min(3))).toBe(min(3))
    expect(applyBuffer(min(5))).toBe(min(5))
    expect(applyBuffer(min(5) + 30)).toBe(30)
    expect(applyBuffer(min(20))).toBe(min(15))
  })
})

describe("headlineFor", () => {
  it("uses instant / ongoing / still-working wording at 10 and 60 minutes", () => {
    expect(headlineFor(min(9.9)).key).toBe("instant")
    expect(headlineFor(min(10)).key).toBe("ongoing")
    expect(headlineFor(min(59.9)).key).toBe("ongoing")
    expect(headlineFor(min(60))).toEqual({ key: "working", text: "Validation Ongoing" })
  })
  it("never says slow or down", () => {
    for (const s of [0, min(5), min(30), min(600)]) expect(headlineFor(s).text).not.toMatch(/slow|down/i)
  })
})

describe("strengthFor", () => {
  it("pins 0-10 min at 100% Excellent and slides to 80% by 30 min", () => {
    expect(strengthFor(0)).toEqual({ percent: 100, tier: "Excellent" })
    expect(strengthFor(min(10))).toEqual({ percent: 100, tier: "Excellent" })
    expect(strengthFor(min(20))).toEqual({ percent: 90, tier: "Excellent" })
    expect(strengthFor(min(30))).toEqual({ percent: 80, tier: "Excellent" })
  })
  it("Good 79->50, Delayed 49->20, Critical down to a 1% floor", () => {
    expect(strengthFor(min(31))).toEqual({ percent: 79, tier: "Good" })
    expect(strengthFor(min(60))).toEqual({ percent: 50, tier: "Good" })
    expect(strengthFor(min(61)).tier).toBe("Delayed")
    expect(strengthFor(min(61)).percent).toBe(49)
    expect(strengthFor(min(180))).toEqual({ percent: 20, tier: "Delayed" })
    expect(strengthFor(min(181))).toEqual({ percent: 19, tier: "Critical" })
    expect(strengthFor(min(10_000))).toEqual({ percent: 1, tier: "Critical" })
  })
  it("moves smoothly (no big steps) as the duration grows", () => {
    let prev = strengthFor(0).percent
    for (let m = 1; m <= 800; m++) {
      const p = strengthFor(min(m)).percent
      expect(prev - p).toBeLessThanOrEqual(2)
      expect(p).toBeGreaterThanOrEqual(1)
      prev = p
    }
  })
})

describe("formatDuration", () => {
  it("shows seconds under a minute, never 0", () => {
    expect(formatDuration(0)).toBe("1 sec")
    expect(formatDuration(0.4)).toBe("1 sec")
    expect(formatDuration(31)).toBe("31 sec")
    expect(formatDuration(59.4)).toBe("59 sec")
  })
  it("branches on precise seconds, so 31-59 s never reads as 1 min", () => {
    expect(formatDuration(45)).toBe("45 sec")
    expect(formatDuration(60)).toBe("1 min")
  })
  it("shows minutes, then hours", () => {
    expect(formatDuration(min(12))).toBe("12 min")
    expect(formatDuration(min(60))).toBe("1 hr")
    expect(formatDuration(min(95))).toBe("1 hr 35 min")
  })
})

describe("computeEstimate", () => {
  const c = { createdAt: ago(min(20)), completedAt: ago(min(12)) } // took 8 min raw -> 3 min adjusted

  it("no completed order at all: no_data", () => {
    expect(computeEstimate({ c: null, p: null, now: NOW }).state).toBe("no_data")
  })
  it("Metric 2 falls back to Metric 1 when nothing is open", () => {
    const e = computeEstimate({ c, p: null, now: NOW })
    expect(e).toMatchObject({ state: "live", lastOrderSeconds: min(3), currentSeconds: min(3), openSince: null })
    expect(e.headline?.key).toBe("instant")
    expect(e.strength).toEqual({ percent: 100, tier: "Excellent" })
  })
  it("Metric 2 is P's live wait against now (buffered); strength still follows Metric 1 only", () => {
    const e = computeEstimate({ c, p: { createdAt: ago(min(75)) }, now: NOW })
    expect(e.currentSeconds).toBe(min(70))
    expect(e.headline?.key).toBe("working")
    expect(e.strength?.tier).toBe("Excellent")
  })
  it("keeps sub-minute precision after the buffer instead of rounding to 0", () => {
    const fast = { createdAt: ago(min(10)), completedAt: ago(min(10) - (min(5) + 40)) } // 5m40s raw
    const e = computeEstimate({ c: fast, p: null, now: NOW })
    expect(e.lastOrderSeconds).toBe(40)
    expect(formatDuration(e.lastOrderSeconds!)).toBe("40 sec")
  })
  it("C older than 24h with nothing newer: no_recent, no numbers", () => {
    const old = { createdAt: ago(min(60 * 25)), completedAt: ago(min(60 * 24.9)) }
    const e = computeEstimate({ c: old, p: null, now: NOW })
    expect(e).toMatchObject({ state: "no_recent", headline: null, strength: null, currentSeconds: null })
  })
  it("an old C is still live when an order is open after it", () => {
    const old = { createdAt: ago(min(60 * 25)), completedAt: ago(min(60 * 24.9)) }
    expect(computeEstimate({ c: old, p: { createdAt: ago(min(2)) }, now: NOW }).state).toBe("live")
  })
  it("a manual down override freezes the snapshot, zeroes strength and drops the headline", () => {
    const live = computeEstimate({ c, p: { createdAt: ago(min(30)) }, now: NOW })
    const override: ChannelOverride = { isManuallyDown: true, reason: "Supplier outage", since: NOW, frozen: freeze(live) }
    const later = new Date(Date.parse(NOW) + min(60) * 1000).toISOString()
    const e = computeEstimate({ c: null, p: null, now: later, override })
    expect(e).toMatchObject({
      state: "down", headline: null, strength: { percent: 0, tier: "Critical" },
      currentSeconds: live.currentSeconds, lastOrderSeconds: live.lastOrderSeconds, openSince: null,
      override: { reason: "Supplier outage", since: NOW },
    })
  })
})

describe("tick", () => {
  it("advances the live wait and its headline without a new fetch", () => {
    const c = { createdAt: ago(min(20)), completedAt: ago(min(15)) }
    const e = computeEstimate({ c, p: { createdAt: ago(min(14)) }, now: NOW }) // 9 min adjusted: instant
    expect(e.headline?.key).toBe("instant")
    const later = tick(e, new Date(Date.parse(NOW) + min(2) * 1000).toISOString())
    expect(later.currentSeconds).toBe(min(11))
    expect(later.headline?.key).toBe("ongoing")
  })
  it("does not move a fallback (no open order) or a down channel", () => {
    const c = { createdAt: ago(min(20)), completedAt: ago(min(15)) }
    const e = computeEstimate({ c, p: null, now: NOW })
    expect(tick(e, new Date(Date.parse(NOW) + 3600_000).toISOString())).toBe(e)
  })
})

describe("confirmScreenText", () => {
  const c = { createdAt: ago(min(20)), completedAt: ago(min(12)) }
  it("shows a short estimate only for a clean, healthy, live channel", () => {
    expect(confirmScreenText(computeEstimate({ c, p: null, now: NOW }))).toBe("Delivery: ~3 min")
    expect(confirmScreenText(computeEstimate({ c, p: { createdAt: ago(min(5) + 50) }, now: NOW }))).toBe("Delivery: ~50 sec")
  })
  it("shows nothing for anything that could read as bad news", () => {
    expect(confirmScreenText(null)).toBeNull()
    expect(confirmScreenText(computeEstimate({ c: null, p: null, now: NOW }))).toBeNull()
    expect(confirmScreenText(computeEstimate({ c, p: { createdAt: ago(min(90)) }, now: NOW }))).toBeNull()
    const slowC = { createdAt: ago(min(200)), completedAt: ago(min(100)) }
    expect(confirmScreenText(computeEstimate({ c: slowC, p: null, now: NOW }))).toBeNull()
    const down: ChannelOverride = { isManuallyDown: true, reason: null, since: NOW, frozen: null }
    expect(confirmScreenText(computeEstimate({ c, p: null, now: NOW, override: down }))).toBeNull()
  })
})
