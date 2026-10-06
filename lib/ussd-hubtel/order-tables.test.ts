// lib/ussd-hubtel/order-tables.test.ts
import { describe, it, expect } from "vitest"
import { ORDER_TABLES, isHubtelOrderTable } from "./order-tables"

// Copied from the CHECK constraint in migrations/0106_hubtel_ussd.sql. A table the channel writes
// but the CHECK does not allow would make every CONFIRM fail at the hubtel_transactions insert.
const ALLOWED_BY_0106 = [
  "ussd_orders", "ussd_shop_orders", "airtime_orders",
  "results_checker_orders", "results_check_requests", "ussd_afa_orders",
]

describe("ORDER_TABLES", () => {
  it("only registers tables the hubtel_transactions CHECK allows", () => {
    for (const t of Object.keys(ORDER_TABLES)) expect(ALLOWED_BY_0106, t).toContain(t)
  })
  it("isHubtelOrderTable recognises registered tables only", () => {
    expect(isHubtelOrderTable("ussd_orders")).toBe(true)
    expect(isHubtelOrderTable("nope")).toBe(false)
    expect(isHubtelOrderTable("toString")).toBe(false)
  })
  it("ussd_orders: payable statuses, fail patch and item name", () => {
    const s = ORDER_TABLES.ussd_orders
    expect(s.payableStatuses).toEqual(["pending", "otp_required"])
    expect(s.failPatch()).toMatchObject({ order_status: "failed", payment_status: "failed" })
    expect(s.cartItemName({ package_size: "5", network: "MTN" })).toBe("5GB MTN Data")
    expect(s.cartItemName({ package_size: "500MB", network: "AT-iShare" })).toBe("500MB AT iShare Data")
  })
  it("every fail patch stamps updated_at and every spec names its cart columns", () => {
    for (const [t, s] of Object.entries(ORDER_TABLES)) {
      expect(s.failPatch(), t).toHaveProperty("updated_at")
      expect(s.cartColumns.length, t).toBeGreaterThan(0)
    }
  })
})
