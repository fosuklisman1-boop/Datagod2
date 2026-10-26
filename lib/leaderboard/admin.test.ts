import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { leaderboardErrorJson, liveStandings } from "./admin"

describe("leaderboardErrorJson", () => {
  it("maps the RPC exceptions to clear statuses", async () => {
    const closed = leaderboardErrorJson({ message: "period_closed" }, "t")
    expect(closed.status).toBe(409)
    expect((await closed.json()).error).toContain("closed")
    expect(leaderboardErrorJson({ message: "prize_not_found" }, "t").status).toBe(404)
    expect(leaderboardErrorJson({ code: "23514", message: "violates check" }, "t").status).toBe(400)
    expect(leaderboardErrorJson({ code: "23505", message: "dup" }, "t").status).toBe(409)
  })
  it("hides unknown errors behind a 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = leaderboardErrorJson({ message: "relation does not exist" }, "t")
    expect(r.status).toBe(500)
    expect((await r.json()).error).not.toContain("relation")
    spy.mockRestore()
  })
})

describe("liveStandings", () => {
  it("joins contact details onto the ranked rows", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { participants: 1, entries: [{ rank: 1, user_id: "u1", first_name: "Anthony", last_name: "Asare", total: 2928.8, orders: 31 }] },
      error: null,
    })
    const inFn = vi.fn().mockResolvedValue({ data: [{ id: "u1", email: "a@x.com", phone_number: "0241234567" }], error: null })
    const db = { rpc, from: () => ({ select: () => ({ in: inFn }) }) } as unknown as SupabaseClient
    expect(await liveStandings(db, "dashboard", { start: "2026-10-01", end: "2026-10-31" })).toEqual([
      { rank: 1, userId: "u1", name: "Anthony Asare", email: "a@x.com", phone: "0241234567", total: 2928.8, orders: 31 },
    ])
    expect(rpc).toHaveBeenCalledWith("get_leaderboard", { p_board: "dashboard", p_from: "2026-10-01", p_to: "2026-10-31", p_limit: 10 })
  })
})
