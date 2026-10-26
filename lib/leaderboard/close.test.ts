import { describe, it, expect } from "vitest"
import { closeReadiness } from "./close"
import type { PrizeRow } from "./prizes"

type P = Pick<PrizeRow, "board" | "rank" | "status">
const all: P[] = (["dashboard", "shop"] as const).flatMap((board) => ([1, 2, 3] as const).map((rank) => ({ board, rank, status: "active" as const })))

describe("closeReadiness", () => {
  it("matches the reference screen for a running month with no prizes", () => {
    const r = closeReadiness("monthly", { status: "open", rewards_enabled: true }, [], false)
    expect(r.note).toBe("This month has not ended yet. You can set prizes now and close it once the month is over.")
    expect(r.problem).toBe("Set a prize for: dashboard rank 1, dashboard rank 2, dashboard rank 3, shop rank 1, shop rank 2, shop rank 3")
    expect(r.helper).toBe("Closing is unavailable until the month has ended.")
    expect(r.canClose || r.canCloseNoReward).toBe(false)
  })

  it("allows both closes once ended with all six prizes", () => {
    const r = closeReadiness("weekly", { status: "open", rewards_enabled: true }, all, true)
    expect(r).toMatchObject({ canClose: true, canCloseNoReward: true, problem: null, helper: null, note: null })
  })

  it("only allows a no-reward close when a prize is missing or cancelled", () => {
    const r = closeReadiness("monthly", { status: "open", rewards_enabled: true }, [...all.slice(1), { board: "dashboard", rank: 1, status: "cancelled" }], true)
    expect(r.canClose).toBe(false)
    expect(r.canCloseNoReward).toBe(true)
    expect(r.problem).toBe("Set a prize for: dashboard rank 1")
  })

  it("explains prizes are off, and a never-configured period can still close without reward", () => {
    expect(closeReadiness("daily", null, [], true)).toMatchObject({
      canClose: false, canCloseNoReward: true, problem: expect.stringContaining("Prizes are off"),
    })
  })

  it("locks a closed period", () => {
    const r = closeReadiness("yearly", { status: "closed", rewards_enabled: true }, all, true)
    expect(r).toMatchObject({ closed: true, canClose: false, canCloseNoReward: false, problem: null })
    expect(r.note).toContain("closed")
    expect(closeReadiness("yearly", { status: "closed_no_reward", rewards_enabled: false }, [], true).note).toBe("This period was closed without rewards.")
  })
})
