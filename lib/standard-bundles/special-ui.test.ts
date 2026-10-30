import { describe, expect, it } from "vitest"
import { quoteForDisplay, type RateEntry } from "@/lib/cashback/display"
import { bundleCardPrice, groupBundleOrders, specialBreakdown, specialGroupStatus, type BundleOrderRow } from "./special-ui"

const hubtel: RateEntry = { provider: "hubtel", rate: 5, share: 60 }

describe("bundleCardPrice", () => {
  it("a normal bundle: exactly quoteForDisplay(amount), unchanged", () => {
    for (const amount of [3, 7.5, 12.37, 50]) {
      const q = quoteForDisplay(amount, hubtel)
      expect(bundleCardPrice({ amount }, hubtel)).toEqual({ pay: q.applied ? q.pay : amount, face: amount, applied: q.applied })
    }
    expect(bundleCardPrice({ amount: 5 }, undefined)).toEqual({ pay: 5, face: 5, applied: false })
  })

  it("a Special entry: n x the per-unit display price (per-unit rounding), face = n x unitAmount", () => {
    const unit = quoteForDisplay(3, hubtel)
    expect(unit.applied).toBe(true)
    for (const n of [1, 3, 5, 8, 10, 15, 20]) {
      const p = bundleCardPrice({ amount: 3 * n, special: { n, unitAmount: 3, unitDisplay: "406.89MB" } }, hubtel)
      expect(p.pay).toBe(Math.round(unit.pay * 100) * n / 100)
      expect(p.face).toBe(3 * n)
      expect(p.applied).toBe(true)
    }
  })

  it("never quotes the total face: per-unit floor differs from quoting n x unitAmount", () => {
    // Find a rate where flooring per unit and flooring the total disagree, and prove we follow the per-unit one.
    let found = false
    for (let rate = 1; rate <= 20 && !found; rate += 0.5) {
      const e: RateEntry = { provider: "hubtel", rate, share: 50 }
      const unitPay = quoteForDisplay(3, e).pay
      const n = 15
      const perUnit = Math.round(unitPay * 100) * n / 100
      const whole = quoteForDisplay(3 * n, e).pay
      if (perUnit !== whole) {
        found = true
        expect(bundleCardPrice({ amount: 3 * n, special: { n, unitAmount: 3, unitDisplay: "406.89MB" } }, e).pay).toBe(perUnit)
      }
    }
    expect(found).toBe(true)
  })

  it("a Special entry without cashback: n x unitAmount, not applied", () => {
    expect(bundleCardPrice({ amount: 9, special: { n: 3, unitAmount: 3, unitDisplay: "406.89MB" } }, undefined))
      .toEqual({ pay: 9, face: 9, applied: false })
  })

  it("no float drift on cents (n x 0.1-style amounts)", () => {
    const p = bundleCardPrice({ amount: 3.3, special: { n: 3, unitAmount: 1.1, unitDisplay: "100MB" } }, undefined)
    expect(p).toEqual({ pay: 3.3, face: 3.3, applied: false })
  })

  it("a malformed special block falls back to the normal price", () => {
    for (const special of [{ n: 0, unitAmount: 3, unitDisplay: "x" }, { n: 2.5, unitAmount: 3, unitDisplay: "x" }, { n: 3, unitAmount: -1, unitDisplay: "x" }, { n: 3, unitAmount: NaN, unitDisplay: "x" }]) {
      expect(bundleCardPrice({ amount: 9, special }, undefined)).toEqual({ pay: 9, face: 9, applied: false })
    }
  })
})

describe("specialBreakdown", () => {
  it("formats n x unit display", () => {
    expect(specialBreakdown({ n: 3, unitAmount: 3, unitDisplay: "406.89MB" })).toBe("3 × 406.89MB")
  })
})

describe("specialGroupStatus", () => {
  it("all completed => Completed", () => {
    expect(specialGroupStatus(["completed", "completed", "completed"])).toEqual({ label: "Completed", tone: "completed" })
  })
  it("any failed => Part delivered — we're on it", () => {
    expect(specialGroupStatus(["completed", "failed", "processing"]).label).toBe("Part delivered — we're on it")
    expect(specialGroupStatus(["failed", "failed"]).label).toBe("Part delivered — we're on it")
  })
  it("a refunded child counts as not delivered too", () => {
    expect(specialGroupStatus(["completed", "refunded"]).label).toBe("Part delivered — we're on it")
  })
  it("otherwise => Processing", () => {
    expect(specialGroupStatus(["completed", "processing"])).toEqual({ label: "Processing", tone: "processing" })
    expect(specialGroupStatus(["pending", "pending"])).toEqual({ label: "Processing", tone: "processing" })
    expect(specialGroupStatus([])).toEqual({ label: "Processing", tone: "processing" })
  })
})

const row = (o: Partial<BundleOrderRow>): BundleOrderRow => ({
  id: "x", reference_code: "SB-x", network: "MTN", beneficiary_phone: "233240000000", bundle_display: "1GB", amount: 5,
  status: "completed", payment_status: "paid", created_at: "2026-10-30T10:00:00Z", ...o,
})

describe("groupBundleOrders", () => {
  it("normal orders pass through unchanged and in order", () => {
    const a = row({ id: "a" }), b = row({ id: "b", special_group_id: null, special_index: null })
    expect(groupBundleOrders([a, b])).toEqual([{ kind: "single", order: a }, { kind: "single", order: b }])
  })

  it("groups a Special group's children into one line at the position of its first row", () => {
    const g = "g1"
    const kids = [3, 2, 1].map(i => row({
      id: `c${i}`, reference_code: `SB-${i}`, bundle_display: "406.89MB", amount: 3, status: "completed",
      special_group_id: g, special_index: i, created_at: "2026-10-30T09:00:00Z",
    }))
    const before = row({ id: "n1", created_at: "2026-10-30T11:00:00Z" })
    const after = row({ id: "n2", created_at: "2026-10-30T08:00:00Z" })
    const lines = groupBundleOrders([before, ...kids, after])
    expect(lines).toHaveLength(3)
    expect(lines[0]).toEqual({ kind: "single", order: before })
    expect(lines[2]).toEqual({ kind: "single", order: after })
    const s = lines[1]
    if (s.kind !== "special") throw new Error("expected special")
    expect(s.groupId).toBe(g)
    expect(s.title).toBe("Special 1.22GB (3 × 406.89MB)")
    expect(s.amount).toBe(9)
    expect(s.count).toBe(3)
    expect(s.status).toEqual({ label: "Completed", tone: "completed" })
    expect(s.reference_code).toBe("SB-1")
    expect(s.network).toBe("MTN")
    expect(s.beneficiary_phone).toBe("233240000000")
    expect(s.created_at).toBe("2026-10-30T09:00:00Z")
  })

  it("sums amounts in cents and combines statuses", () => {
    const kids = [1, 2, 3].map(i => row({
      id: `c${i}`, bundle_display: "406.89MB", amount: 1.1, status: i === 2 ? "failed" : "completed",
      special_group_id: "g", special_index: i,
    }))
    const [line] = groupBundleOrders(kids)
    if (line.kind !== "special") throw new Error("expected special")
    expect(line.amount).toBe(3.3)
    expect(line.status.label).toBe("Part delivered — we're on it")
  })

  it("keeps two groups apart and handles non-adjacent children", () => {
    const rows = [
      row({ id: "a1", special_group_id: "A", special_index: 1, bundle_display: "406.89MB", amount: 3, status: "processing" }),
      row({ id: "b1", special_group_id: "B", special_index: 1, bundle_display: "406.89MB", amount: 3 }),
      row({ id: "a2", special_group_id: "A", special_index: 2, bundle_display: "406.89MB", amount: 3 }),
    ]
    const lines = groupBundleOrders(rows)
    expect(lines.map(l => (l.kind === "special" ? `${l.groupId}:${l.count}` : "single"))).toEqual(["A:2", "B:1"])
    expect(lines[0].kind === "special" && lines[0].status.label).toBe("Processing")
  })

  it("an unparseable unit size still gives a readable title", () => {
    const [line] = groupBundleOrders([1, 2].map(i => row({ id: `c${i}`, bundle_display: "Kokoo", special_group_id: "g", special_index: i })))
    if (line.kind !== "special") throw new Error("expected special")
    expect(line.title).toBe("Special 2 × Kokoo")
  })
})
