import { describe, it, expect } from "vitest"
import { composeOverview, type OverviewRow } from "./admin-overview"
import type { WholesaleSnapshot } from "./wholesale"

const row: OverviewRow = {
  revenue_bundles_ghs: "120.50", revenue_activations_ghs: "71", credits_sold: 7111, purchases: 56,
  unrecorded_purchases: 54, unrecorded_credits: 7000, pending_reviews: 2, pending_senders: 3, fraud_flags: 4, info_flags: 1,
}
const snap: WholesaleSnapshot = { provider: "moolre", backedCredits: 650, balanceGhs: null, ratePerSms: null, queuedUnsent: 250 }
const ctx = { featureEnabled: true, policyEnforced: false, provider: "moolre" }

describe("composeOverview", () => {
  it("sums recorded revenue and maps stats + tab counts", () => {
    const o = composeOverview(row, [], snap, ctx)
    expect(o.stats).toEqual({
      recordedRevenueGhs: 191.5, bundleRevenueGhs: 120.5, activationRevenueGhs: 71,
      creditsSold: 7111, purchases: 56, pendingReviews: 2, pendingSenders: 3, fraudFlags: 4,
    })
    expect(o.tabCounts).toEqual({ businessReviews: 2, senderIds: 3, flagged: 5 })
    expect(o.unrecorded).toEqual({ purchases: 54, credits: 7000 })
    expect(o.supply).toBe(snap)
    expect(o.featureEnabled).toBe(true)
    expect(o.policyEnforced).toBe(false)
  })
  it("treats a missing row as zeros (never NaN)", () => {
    const o = composeOverview(null, [], snap, ctx)
    expect(o.stats.recordedRevenueGhs).toBe(0)
    expect(o.stats.creditsSold).toBe(0)
    expect(o.tabCounts.flagged).toBe(0)
  })
  it("maps and orders the policy preview", () => {
    const o = composeOverview(row, [{ decision: "allow", code: "OK", n: "10" }, { decision: "block", code: "LINK_NOT_ALLOWED", n: 3 }], snap, ctx)
    expect(o.policyPreview).toEqual([
      { decision: "allow", code: "OK", count: 10 },
      { decision: "block", code: "LINK_NOT_ALLOWED", count: 3 },
    ])
  })
  it("rounds money to 2dp", () => {
    const o = composeOverview({ ...row, revenue_bundles_ghs: "0.1", revenue_activations_ghs: "0.2" }, [], snap, ctx)
    expect(o.stats.recordedRevenueGhs).toBe(0.3)
  })
})
