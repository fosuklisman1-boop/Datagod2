import { describe, it, expect } from "vitest"
import { isRefundSweepDue } from "./sweep-schedule"

describe("isRefundSweepDue", () => {
  it("is due on every 10th UTC minute only", () => {
    for (const m of [0, 10, 20, 30, 40, 50]) expect(isRefundSweepDue(new Date(Date.UTC(2026, 10, 21, 12, m, 59)))).toBe(true)
    for (const m of [1, 3, 9, 11, 59]) expect(isRefundSweepDue(new Date(Date.UTC(2026, 10, 21, 12, m, 0)))).toBe(false)
  })
})
