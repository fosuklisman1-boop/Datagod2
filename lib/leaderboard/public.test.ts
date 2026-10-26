import { describe, it, expect } from "vitest"
import { resolveLeaderboardConfig, toPublicBoard, periodView, headerTitle, countingRule, formatCedis, publicRewards, rewardLine, boardsFromResults, rewardsFromResults, myRankFromResults } from "./public"
import { periodRange } from "./periods"

describe("resolveLeaderboardConfig", () => {
  it("is running unless paused is exactly true", () => {
    expect(resolveLeaderboardConfig({ paused: true })).toEqual({ paused: true })
    for (const raw of [null, undefined, "x", [], {}, { paused: "true" }, { paused: 1 }]) {
      expect(resolveLeaderboardConfig(raw)).toEqual({ paused: false })
    }
  })
})

describe("toPublicBoard", () => {
  it("removes user ids and flags the viewer", () => {
    const out = toPublicBoard({
      participants: 2,
      entries: [
        { rank: 1, userId: "u1", name: "Anthony A.", total: 10, orders: 1 },
        { rank: 2, userId: "me", name: "Dev P.", total: 5, orders: 2 },
      ],
    }, "me")
    expect(out.entries.map((e) => e.isMe)).toEqual([false, true])
    expect(JSON.stringify(out)).not.toContain("u1")
  })
})

describe("periodView", () => {
  const now = new Date("2026-10-26T16:47:00Z")

  it("describes the current month like the reference screen", () => {
    expect(periodView("monthly", periodRange("monthly", "2026-10-26"), now)).toEqual({
      kind: "monthly",
      range: { start: "2026-10-01", end: "2026-10-31" },
      label: "October 2026",
      timeLeft: "6 days left in October",
      ended: false,
      prevAnchor: "2026-09-01",
      nextAnchor: null,
    })
  })

  it("lets a past period step forward and marks it ended", () => {
    const v = periodView("weekly", periodRange("weekly", "2026-10-14"), now)
    expect(v).toMatchObject({ ended: true, timeLeft: null, prevAnchor: "2026-10-05", nextAnchor: "2026-10-19" })
  })
})

describe("publicRewards", () => {
  const prizes = [
    { board: "dashboard" as const, rank: 1, label: "GH₵50 Cash", status: "active" },
    { board: "dashboard" as const, rank: 2, label: "Old", status: "cancelled" },
    { board: "shop" as const, rank: 3, label: "10GB MTN", status: "active" },
  ]
  it("shows active prizes only when rewards are on", () => {
    expect(publicRewards({ rewards_enabled: true }, prizes)).toEqual({ dashboard: { 1: "GH₵50 Cash" }, shop: { 3: "10GB MTN" } })
    expect(publicRewards({ rewards_enabled: false }, prizes)).toBeNull()
    expect(publicRewards(null, prizes)).toBeNull()
    expect(publicRewards({ rewards_enabled: true }, [prizes[1]])).toBeNull()
  })
  it("words the reward line per period", () => {
    expect(rewardLine("monthly")).toBe("The top 3 sellers in each category win a reward every month.")
  })
})

describe("frozen results", () => {
  const prize = (label: string, status: "active" | "cancelled" = "active") => ({ id: "p", label, prize_type: "manual", status })
  const results = [
    { id: "r2", board: "dashboard" as const, rank: 2, userId: "u2", displayName: "Dev P.", total: 20, orders: 2, prize: prize("Cap", "cancelled") },
    { id: "r1", board: "dashboard" as const, rank: 1, userId: "u1", displayName: "Anthony A.", total: 30, orders: 3, prize: prize("GH₵50 Cash") },
    { id: "r4", board: "dashboard" as const, rank: 4, userId: "u4", displayName: "Abdul G.", total: 5, orders: 1, prize: null },
    { id: "s1", board: "shop" as const, rank: 1, userId: "u9", displayName: "Michael I.", total: 900, orders: 9, prize: prize("GH₵100 Cash") },
  ]
  it("rebuilds the boards in rank order with the frozen names", () => {
    const b = boardsFromResults(results)
    expect(b.dashboard.entries.map((e) => e.name)).toEqual(["Anthony A.", "Dev P.", "Abdul G."])
    expect(b.shop).toEqual({ participants: 1, entries: [{ rank: 1, userId: "u9", name: "Michael I.", total: 900, orders: 9 }] })
  })
  it("gives a frozen rank without gaps, or null outside the results", () => {
    expect(myRankFromResults(results, "dashboard", "u2")).toEqual({ participants: 3, rank: 2, total: 20, orders: 2, gapToNext: null, gapToTop3: null })
    expect(myRankFromResults(results, "shop", "u2")).toBeNull()
  })
  it("lists only prizes that were not cancelled", () => {
    expect(rewardsFromResults(results)).toEqual({ dashboard: { 1: "GH₵50 Cash" }, shop: { 1: "GH₵100 Cash" } })
    expect(rewardsFromResults(results.filter((r) => r.prize === null))).toBeNull()
  })
})

describe("formatCedis", () => {
  it("matches the reference amounts", () => {
    expect(formatCedis(156764.61)).toBe("GH₵ 156,764.61")
    expect(formatCedis(816)).toBe("GH₵ 816.00")
    expect(formatCedis(0)).toBe("GH₵ 0.00")
  })
})

describe("copy", () => {
  it("names the period in the title and the rule", () => {
    expect(headerTitle("monthly")).toBe("Monthly top performers")
    expect(countingRule("monthly")).toBe("Sales are counted from the 1st to the last day of each month (Ghana time). Only completed sales count.")
    expect(countingRule("weekly")).toContain("Monday to Sunday")
  })
})
