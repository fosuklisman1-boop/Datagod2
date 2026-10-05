import { splitRefundLocked, isRefundLocked } from "./bulk-guard"

describe("splitRefundLocked", () => {
  it("drops refunding/refunded rows and reports them with a reason", () => {
    const { allowed, locked } = splitRefundLocked([
      { id: "a", order_status: "pending" }, { id: "b", order_status: "refunding" },
      { id: "c", order_status: "refunded" }, { id: "d", order_status: "completed" },
    ])
    expect(allowed.map((r) => r.id)).toEqual(["a", "d"])
    expect(locked.map((r) => r.id)).toEqual(["b", "c"])
    expect(locked[0].reason).toMatch(/refunding/)
  })
  it("keeps rows with no order_status and tolerates null input", () => {
    expect(splitRefundLocked([{ id: "x" }]).allowed).toHaveLength(1)
    expect(splitRefundLocked(null)).toEqual({ allowed: [], locked: [] })
  })
  it("preserves extra fields", () => {
    expect(splitRefundLocked([{ id: "a", order_status: "pending", n: 1 }]).allowed[0]).toEqual({ id: "a", order_status: "pending", n: 1 })
  })
  it("isRefundLocked", () => {
    expect(isRefundLocked("refunding")).toBe(true)
    expect(isRefundLocked("failed")).toBe(false)
    expect(isRefundLocked(undefined)).toBe(false)
  })
})

describe("splitRefundLocked: tables whose column is `status` (orders / api_orders)", () => {
  it("locks refunding/refunded by status", () => {
    const { allowed, locked } = splitRefundLocked([
      { id: "a", status: "pending" }, { id: "b", status: "refunding" }, { id: "c", status: "refunded" }, { id: "d", status: "held_registration" },
    ])
    expect(allowed.map((r) => r.id)).toEqual(["a", "d"])
    expect(locked.map((r) => r.id)).toEqual(["b", "c"])
    expect(locked[0].reason).toMatch(/refunding/)
  })
})
