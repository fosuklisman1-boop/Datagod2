// lib/ussd-hubtel/order-tables.test.ts
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { ORDER_TABLES, cartItemNameFor, isHubtelOrderTable, BOT_UNPAID_FAILURE_REASON } from "./order-tables"

// Copied from the CHECK constraint in migrations/0106_hubtel_ussd.sql, as widened by
// migrations/0124_hubtel_ussd_bot_orders.sql. A table the channel writes but the CHECK does not allow
// would make every CONFIRM fail at the hubtel_transactions insert.
const ALLOWED_BY_0106 = [
  "ussd_orders", "ussd_shop_orders", "airtime_orders",
  "results_checker_orders", "results_check_requests", "ussd_afa_orders",
]
const ADDED_BY_0124 = ["hubtel_bill_orders", "hubtel_data_orders"]
const ALLOWED = [...ALLOWED_BY_0106, ...ADDED_BY_0124]

/** The IN-list of the hubtel_transactions_order_table_check that migration 0124 creates. */
function checkListIn0124(): string[] {
  const sql = readFileSync(join(process.cwd(), "migrations", "0124_hubtel_ussd_bot_orders.sql"), "utf8")
  const m = sql.match(/ADD CONSTRAINT hubtel_transactions_order_table_check\s+CHECK \(order_table IN \(([^)]*)\)\)/)
  if (!m) throw new Error("0124: order_table CHECK not found")
  return Array.from(m[1].matchAll(/'([a-z_]+)'/g), x => x[1])
}

describe("ORDER_TABLES", () => {
  it("only registers tables the hubtel_transactions CHECK allows", () => {
    for (const t of Object.keys(ORDER_TABLES)) expect(ALLOWED, t).toContain(t)
  })
  it("migration 0124's CHECK is exactly the 0106 list plus the two bot order tables", () => {
    expect(checkListIn0124().sort()).toEqual([...ALLOWED].sort())
  })
  it("registers every table the widened CHECK allows", () => {
    expect(Object.keys(ORDER_TABLES).sort()).toEqual([...ALLOWED].sort())
  })
  for (const t of ["hubtel_bill_orders", "hubtel_data_orders"] as const) {
    it(`${t}: payable while unpaid; fail patch = failed + reason, payment_status untouched; bots + pending only`, () => {
      const s = ORDER_TABLES[t]
      expect(s.payableStatuses).toEqual(["unpaid"])
      const p = s.failPatch()
      expect(p).toMatchObject({ status: "failed", failure_reason: "payment not completed" })
      expect(BOT_UNPAID_FAILURE_REASON).toBe("payment not completed")
      expect(p).not.toHaveProperty("payment_status")
      expect(s.failGuards).toEqual({ channel: ["bots"], status: ["pending"] })
    })
  }
  it("isHubtelOrderTable recognises registered tables only", () => {
    expect(isHubtelOrderTable("ussd_orders")).toBe(true)
    expect(isHubtelOrderTable("nope")).toBe(false)
    expect(isHubtelOrderTable("toString")).toBe(false)
  })
  it("ussd_orders: payable statuses and fail patch", () => {
    const s = ORDER_TABLES.ussd_orders
    expect(s.payableStatuses).toEqual(["pending", "otp_required"])
    expect(s.failPatch()).toMatchObject({ order_status: "failed", payment_status: "failed" })
  })
  it("ussd_shop_orders: payable statuses and fail patch", () => {
    const s = ORDER_TABLES.ussd_shop_orders
    expect(s.payableStatuses).toEqual(["pending", "otp_required"])
    expect(s.failPatch()).toMatchObject({ order_status: "failed", payment_status: "failed" })
  })
  it("airtime_orders: payable statuses and fail patch", () => {
    const s = ORDER_TABLES.airtime_orders
    expect(s.payableStatuses).toEqual(["pending_payment", "otp_required"])
    expect(s.failPatch()).toMatchObject({ status: "failed", payment_status: "failed" })
  })
  it("results_checker_orders: payable statuses and fail patch", () => {
    const s = ORDER_TABLES.results_checker_orders
    expect(s.payableStatuses).toEqual(["pending_payment", "otp_required"])
    expect(s.failPatch()).toMatchObject({ status: "failed", payment_status: "failed" })
  })
  it("results_check_requests: payable statuses and fail patch", () => {
    const s = ORDER_TABLES.results_check_requests
    expect(s.payableStatuses).toEqual(["pending_payment", "otp_required"])
    expect(s.failPatch()).toMatchObject({ status: "failed", payment_status: "failed" })
  })
  it("ussd_afa_orders: payable statuses and fail patch", () => {
    const s = ORDER_TABLES.ussd_afa_orders
    expect(s.payableStatuses).toEqual(["pending"])
    expect(s.failPatch()).toMatchObject({ order_status: "failed", payment_status: "failed" })
  })
  it("every fail patch stamps updated_at", () => {
    for (const [t, s] of Object.entries(ORDER_TABLES)) {
      expect(s.failPatch(), t).toHaveProperty("updated_at")
    }
  })
})

describe("cartItemNameFor", () => {
  it("is 'CH order' + the first 8 characters of the order id (no dashes, lowercase)", () => {
    expect(cartItemNameFor("3FA85F64-5717-4562-b3fc-2c963f66afa6")).toBe("CH order 3fa85f64")
  })
  it("is the same for the same order id (a replay re-sends an identical cart)", () => {
    const id = "9b2e4c1a-0000-4000-8000-123456789abc"
    expect(cartItemNameFor(id)).toBe(cartItemNameFor(id))
  })
  it("does not carry service names, phone numbers or sizes", () => {
    expect(cartItemNameFor("9b2e4c1a-0000-4000-8000-123456789abc")).toMatch(/^CH order [a-z0-9]{8}$/)
  })
  it("works for a short or numeric id", () => {
    expect(cartItemNameFor("ab12")).toBe("CH order ab12")
    expect(cartItemNameFor(123456789)).toBe("CH order 12345678")
  })
})
