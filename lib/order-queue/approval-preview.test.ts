import { describe, it, expect } from "vitest"
import { makeFakeDb } from "./fake-db.test-helper"
import { previewApprovals } from "./approval-preview"

const NOW = new Date("2026-11-22T12:00:00.000Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const D = 86_400_000
const H = 3_600_000
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
// Obviously fake numbers
const P1 = "0240000001"
const P2 = "0240000002"
const P3 = "0240000003"
const P4 = "0240000004"

const baseTables = () => ({
  admin_settings: [{ key: "mtn_strict_supplier_verification", value: { enabled: true } }],
  orders: [
    { id: id(1), network: "MTN", phone_number: P1 },
    { id: id(2), network: "mtn", phone_number: P2 },
    { id: id(3), network: "MTN", phone_number: P3 },
    { id: id(4), network: "Telecel", phone_number: P1 },
    { id: id(5), network: "MTN", phone_number: "233240000001" },
  ],
  shop_orders: [
    { id: id(10), network: "MTN", customer_phone: P4, payment_status: "completed" },
    { id: id(11), network: "MTN", customer_phone: P1, payment_status: "pending" },
  ],
  mtn_supplier_verdicts: [
    { phone: P1, supplier: "hubnet", verdict: "yes", checked_at: ago(5 * D) },
    { phone: P2, supplier: "hubnet", verdict: "no", checked_at: ago(2 * H) },
    { phone: P3, supplier: "hubnet", verdict: "yes", checked_at: ago(31 * D) },
    { phone: P4, supplier: "hubnet", verdict: "yes", checked_at: ago(1 * D) },
    { phone: P1, supplier: "sykes", verdict: "no", checked_at: ago(1 * H) },
  ],
})

const statusOf = (r: any, n: number) => r.perOrder.find((o: any) => o.id === id(n))?.status

describe("previewApprovals", () => {
  it("counts from saved verdicts for the picked supplier only", async () => {
    const db = makeFakeDb(baseTables())
    const orders = [
      { id: id(1), type: "bulk" as const },
      { id: id(2), type: "bulk" as const },
      { id: id(3), type: "bulk" as const },
      { id: id(10), type: "shop" as const },
    ]
    const r = await previewApprovals(db as any, orders, "hubnet", NOW)
    expect(r.enabled).toBe(true)
    expect(statusOf(r, 1)).toBe("approved")
    expect(statusOf(r, 2)).toBe("not_approved")
    expect(statusOf(r, 3)).toBe("not_checked") // stale yes
    expect(statusOf(r, 10)).toBe("approved")
    expect(r.counts).toEqual({ approved: 2, notApproved: 1, notChecked: 1 })
  })

  it("matches 233 phone formats to the saved 0 format", async () => {
    const db = makeFakeDb(baseTables())
    const r = await previewApprovals(db as any, [{ id: id(5), type: "bulk" }], "hubnet", NOW)
    expect(statusOf(r, 5)).toBe("approved")
  })

  it("non-MTN, unknown and unpaid orders are not_checked", async () => {
    const db = makeFakeDb(baseTables())
    const r = await previewApprovals(
      db as any,
      [
        { id: id(4), type: "bulk" },
        { id: id(11), type: "shop" },
        { id: id(99), type: "bulk" },
      ],
      "hubnet",
      NOW,
    )
    expect(statusOf(r, 4)).toBe("not_checked")
    expect(statusOf(r, 11)).toBe("not_checked")
    expect(statusOf(r, 99)).toBe("not_checked")
    expect(r.counts).toEqual({ approved: 0, notApproved: 0, notChecked: 3 })
  })

  it("never calls a supplier and never returns a phone number", async () => {
    const db = makeFakeDb(baseTables())
    const r = await previewApprovals(db as any, [{ id: id(1), type: "bulk" }], "hubnet", NOW)
    expect(JSON.stringify(r)).not.toContain("024000")
    // Only database reads: no writes of any kind.
    expect(db.calls.every((c) => c.kind === "select")).toBe(true)
  })

  it("switch off: enabled false and no verdict read", async () => {
    const t = baseTables()
    t.admin_settings = [{ key: "mtn_strict_supplier_verification", value: { enabled: false } }]
    const db = makeFakeDb(t)
    const r = await previewApprovals(db as any, [{ id: id(1), type: "bulk" }], "hubnet", NOW)
    expect(r.enabled).toBe(false)
    expect(r.perOrder).toEqual([])
    expect(db.calls.some((c) => c.table === "mtn_supplier_verdicts" || c.table === "orders")).toBe(false)
  })

  it("duplicate ids are counted once", async () => {
    const db = makeFakeDb(baseTables())
    const r = await previewApprovals(db as any, [{ id: id(1), type: "bulk" }, { id: id(1), type: "bulk" }], "hubnet", NOW)
    expect(r.perOrder).toHaveLength(1)
    expect(r.counts.approved).toBe(1)
  })
})
