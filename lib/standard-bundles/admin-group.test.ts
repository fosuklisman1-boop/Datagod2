import { describe, it, expect } from "vitest"
import { groupAdminRows, specialGroupSummary } from "./admin-group"

type R = { id: string; status: string; amount: number; bundle_display: string; special_group_id?: string | null; special_index?: number | null; special_size?: number | null }
const unit = (id: string, g: string, i: number, status = "completed", size: number | null = 5): R =>
  ({ id, status, amount: 3, bundle_display: "406.89MB", special_group_id: g, special_index: i, special_size: size })
const single = (id: string, status = "completed"): R => ({ id, status, amount: 10, bundle_display: "1GB" })

describe("groupAdminRows", () => {
  it("puts every unit of a Special order on one card, in unit order, where its first unit appeared", () => {
    const rows = [single("a"), unit("u3", "g1", 3), unit("u1", "g1", 1), single("b"), unit("u2", "g1", 2)]
    const lines = groupAdminRows(rows)
    expect(lines.map(l => l.kind)).toEqual(["single", "special", "single"])
    const g = lines[1]
    if (g.kind !== "special") throw new Error("expected special")
    expect(g.units.map(u => u.id)).toEqual(["u1", "u2", "u3"])
    expect(g.groupId).toBe("g1")
  })

  it("keeps two Special orders on separate cards", () => {
    const lines = groupAdminRows([unit("x1", "g1", 1), unit("y1", "g2", 1), unit("x2", "g1", 2)])
    expect(lines).toHaveLength(2)
    expect(lines.map(l => (l.kind === "special" ? l.units.length : 0))).toEqual([2, 1])
  })

  it("leaves normal orders and admin replacements (no group id) as their own rows", () => {
    const resend: R = { id: "r", status: "completed", amount: 3, bundle_display: "406.89MB", special_group_id: null, special_index: null }
    const lines = groupAdminRows([single("a"), resend])
    expect(lines.map(l => l.kind)).toEqual(["single", "single"])
  })
})

describe("specialGroupSummary", () => {
  it("all delivered: '5/5 delivered', total = size × unit price, title in GB", () => {
    const s = specialGroupSummary([1, 2, 3, 4, 5].map(i => unit(`u${i}`, "g", i)))
    expect(s.size).toBe(5)
    expect(s.delivered).toBe(5)
    expect(s.label).toBe("5/5 delivered")
    expect(s.tone).toBe("completed")
    expect(s.total).toBe(15)
    expect(s.title).toBe("Special 2.03GB (5 × 406.89MB)")
    expect(s.missingFromPage).toBe(0)
  })

  it("while sending: counts delivered and in-progress units separately", () => {
    const s = specialGroupSummary([unit("1", "g", 1), unit("2", "g", 2), unit("3", "g", 3, "processing"), unit("4", "g", 4, "pending"), unit("5", "g", 5, "pending")])
    expect(s.label).toBe("2/5 delivered · 3 sending")
    expect(s.tone).toBe("processing")
  })

  it("flags failed and refunded units", () => {
    const s = specialGroupSummary([unit("1", "g", 1), unit("2", "g", 2, "failed"), unit("3", "g", 3, "refunded")].map(u => ({ ...u, special_size: 3 })))
    expect(s.label).toBe("1/3 delivered · 1 failed · 1 refunded")
    expect(s.tone).toBe("failed")
  })

  it("reports units not on this page (paging or a status filter hid them)", () => {
    const s = specialGroupSummary([unit("2", "g", 2, "failed")])
    expect(s.size).toBe(5)
    expect(s.missingFromPage).toBe(4)
    expect(s.label).toBe("0/5 delivered · 1 failed")
  })

  it("falls back to the units on the page when the group size could not be read", () => {
    const s = specialGroupSummary([unit("1", "g", 1, "completed", null), unit("2", "g", 2, "completed", null)])
    expect(s.size).toBe(2)
    expect(s.missingFromPage).toBe(0)
    expect(s.label).toBe("2/2 delivered")
  })
})
