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
  it("airtime_orders: payable statuses, fail patch and item name", () => {
    const s = ORDER_TABLES.airtime_orders
    expect(s.payableStatuses).toEqual(["pending_payment", "otp_required"])
    expect(s.failPatch()).toMatchObject({ status: "failed", payment_status: "failed" })
    expect(s.cartItemName({ network: "AT", beneficiary_phone: "0271234567" })).toBe("AT Airtime to 0271234567")
  })
  it("results_checker_orders: payable statuses, fail patch and item name", () => {
    const s = ORDER_TABLES.results_checker_orders
    expect(s.payableStatuses).toEqual(["pending_payment", "otp_required"])
    expect(s.failPatch()).toMatchObject({ status: "failed", payment_status: "failed" })
    expect(s.cartItemName({ exam_board: "BECE", quantity: 3 })).toBe("BECE Checker x3")
  })
  it("results_check_requests: payable statuses, fail patch and item names", () => {
    const s = ORDER_TABLES.results_check_requests
    expect(s.payableStatuses).toEqual(["pending_payment", "otp_required"])
    expect(s.failPatch()).toMatchObject({ status: "failed", payment_status: "failed" })
    expect(s.cartItemName({ exam_board: "BECE", mode: "combo" })).toBe("BECE Voucher + Results Check")
    expect(s.cartItemName({ exam_board: "BECE", mode: "own_voucher" })).toBe("BECE Results Check")
  })
  it("results_check_requests: cartItemName works on a row narrowed to its cartColumns, both modes", () => {
    const s = ORDER_TABLES.results_check_requests
    const cols = s.cartColumns.split(",").map(c => c.trim())
    const full = (mode: string): Record<string, unknown> => ({ id: "x", exam_board: "WASSCE", mode, fee: 22, index_number: "0070202043", voucher_pin: null })
    for (const mode of ["combo", "own_voucher"]) {
      const narrowed = Object.fromEntries(cols.map(c => [c, full(mode)[c]]))
      expect(s.cartItemName(narrowed)).toBe(s.cartItemName(full(mode)))
      expect(s.cartItemName(narrowed)).not.toContain("undefined")
    }
    expect(s.cartItemName(Object.fromEntries(cols.map(c => [c, full("combo")[c]])))).toBe("WASSCE Voucher + Results Check")
    expect(s.cartItemName(Object.fromEntries(cols.map(c => [c, full("own_voucher")[c]])))).toBe("WASSCE Results Check")
  })
  it("cartItemName works on a row narrowed to the table's cartColumns (a missing column would be caught)", () => {
    const fullRow: Record<string, unknown> = {
      network: "Telecel", beneficiary_phone: "0201234567", package_size: "5", airtime_amount: 9.52, total_paid: 10, id: "x", exam_board: "WASSCE", quantity: 2, mode: "own_voucher",
    }
    for (const [t, s] of Object.entries(ORDER_TABLES)) {
      const cols = s.cartColumns.split(",").map(c => c.trim())
      const narrowed = Object.fromEntries(cols.map(c => [c, fullRow[c]]))
      expect(s.cartItemName(narrowed), t).toBe(s.cartItemName(fullRow))
      expect(s.cartItemName(narrowed), t).not.toContain("undefined")
    }
    expect(ORDER_TABLES.results_checker_orders.cartItemName({ exam_board: "WASSCE", quantity: 2 })).toBe("WASSCE Checker x2")
    expect(ORDER_TABLES.airtime_orders.cartItemName({ network: "Telecel", beneficiary_phone: "0201234567" })).toBe("Telecel Airtime to 0201234567")
  })
  it("ussd_afa_orders: payable statuses, fail patch and item name", () => {
    const s = ORDER_TABLES.ussd_afa_orders
    expect(s.payableStatuses).toEqual(["pending"])
    expect(s.failPatch()).toMatchObject({ order_status: "failed", payment_status: "failed" })
    expect(s.cartItemName({ id: "x" })).toBe("AFA Registration")
  })
  it("ussd_afa_orders: cartItemName works on a row narrowed to its cartColumns", () => {
    const s = ORDER_TABLES.ussd_afa_orders
    const cols = s.cartColumns.split(",").map(c => c.trim())
    const full: Record<string, unknown> = { id: "x", full_name: "Kwame Mensah", gh_card_number: "GHA-123456789-0", amount: 50 }
    const narrowed = Object.fromEntries(cols.map(c => [c, full[c]]))
    expect(s.cartItemName(narrowed)).toBe("AFA Registration")
    expect(s.cartItemName(narrowed)).toBe(s.cartItemName(full))
  })
  it("every fail patch stamps updated_at and every spec names its cart columns", () => {
    for (const [t, s] of Object.entries(ORDER_TABLES)) {
      expect(s.failPatch(), t).toHaveProperty("updated_at")
      expect(s.cartColumns.length, t).toBeGreaterThan(0)
    }
  })
})
