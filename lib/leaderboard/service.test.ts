import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { maskName, shapeLeaderboard, shapeMyRank, getLeaderboard, refreshLeaderboardTotals } from "./service"

describe("maskName", () => {
  it("shows first name and last initial, keeping stored casing", () => {
    expect(maskName("Anthony", "Asare")).toBe("Anthony A.")
    expect(maskName("RICHMOND", "Addo")).toBe("RICHMOND A.")
    expect(maskName("elijah", "essien")).toBe("elijah E.")
  })
  it("uses only the first given name", () => {
    expect(maskName("  Abdul Gafar ", "Musah")).toBe("Abdul M.")
  })
  it("falls back when names are missing", () => {
    expect(maskName("Kofi", "")).toBe("Kofi")
    expect(maskName(null, "Mensah")).toBe("M.")
    expect(maskName(undefined, null)).toBe("Seller")
  })
})

describe("shapeLeaderboard", () => {
  it("masks names and coerces numbers", () => {
    const out = shapeLeaderboard({
      participants: 42,
      entries: [{ rank: 1, user_id: "u1", first_name: "Anthony", last_name: "Asare", total: "2928.8", orders: 31 }],
    })
    expect(out).toEqual({ participants: 42, entries: [{ rank: 1, userId: "u1", name: "Anthony A.", total: 2928.8, orders: 31 }] })
    expect(JSON.stringify(out)).not.toContain("Asare")
  })
  it("survives an empty or malformed payload", () => {
    expect(shapeLeaderboard(null)).toEqual({ participants: 0, entries: [] })
    expect(shapeLeaderboard({ entries: "nope" })).toEqual({ participants: 0, entries: [] })
  })
})

describe("shapeMyRank", () => {
  it("gives gaps to the next rank and the podium", () => {
    expect(shapeMyRank({ participants: 30, rank: 7, total: 1128.42, orders: 9, next_total: 1179.8, third_total: 2357.1 }))
      .toEqual({ participants: 30, rank: 7, total: 1128.42, orders: 9, gapToNext: 51.38, gapToTop3: 1228.68 })
  })
  it("has no podium gap inside the top 3 and no next gap at #1", () => {
    const first = shapeMyRank({ participants: 30, rank: 1, total: 2928.8, orders: 1, next_total: null, third_total: 2357.1 })
    expect(first.gapToNext).toBeNull()
    expect(first.gapToTop3).toBeNull()
    expect(shapeMyRank({ participants: 30, rank: 3, total: 10, orders: 1, next_total: 20, third_total: 10 }).gapToTop3).toBeNull()
  })
  it("never says GH₵0 more when a tie-break put the user below", () => {
    expect(shapeMyRank({ participants: 5, rank: 4, total: 40, orders: 1, next_total: 40, third_total: 40 }))
      .toMatchObject({ gapToNext: 0.01, gapToTop3: 0.01 })
  })
  it("handles a user with no sales yet", () => {
    expect(shapeMyRank({ participants: 12, rank: null, total: 0, orders: 0, next_total: null, third_total: 300 }))
      .toEqual({ participants: 12, rank: null, total: 0, orders: 0, gapToNext: null, gapToTop3: 300 })
  })
})

describe("rpc wrappers", () => {
  const fakeDb = (result: { data: unknown; error: { message: string } | null }) => {
    const rpc = vi.fn().mockResolvedValue(result)
    return { db: { rpc } as unknown as SupabaseClient, rpc }
  }

  it("passes the board, range and limit through", async () => {
    const { db, rpc } = fakeDb({ data: { participants: 0, entries: [] }, error: null })
    await getLeaderboard(db, "shop", { start: "2026-10-01", end: "2026-10-31" })
    expect(rpc).toHaveBeenCalledWith("get_leaderboard", { p_board: "shop", p_from: "2026-10-01", p_to: "2026-10-31", p_limit: 30 })
  })

  it("throws on rpc errors instead of returning an empty board", async () => {
    const { db } = fakeDb({ data: null, error: { message: "boom" } })
    await expect(refreshLeaderboardTotals(db, { start: "2026-10-25", end: "2026-10-26" })).rejects.toThrow("boom")
  })
})
