import { describe, it, expect } from "vitest"
import { classifyOrder as classifyFromNotify } from "../notify"
import { classifyOrder, classifyStatusOrder } from "./classify"
import type { OrderKind } from "./types"

describe("classifyOrder", () => {
  it("is the same function notify.ts re-exports (its cases live in notify.test.ts and run through that import)", () => {
    expect(classifyFromNotify).toBe(classifyOrder)
  })
})

describe("classifyStatusOrder (airtime_orders / results_checker_orders vocabulary)", () => {
  // Columns: payment_status, status (the order column), expected kind.
  const table: [string, string, OrderKind][] = [
    ["pending_payment", "pending_payment", "waiting"],
    ["otp_required", "pending_payment", "waiting"],
    ["pending", "pending_payment", "waiting"],
    ["failed", "failed", "payment_failed"],
    ["expired", "expired", "payment_failed"],
    ["abandoned", "pending_payment", "payment_failed"],
    ["cancelled", "pending_payment", "payment_failed"],
    ["pending_payment", "failed", "payment_failed"],
    ["pending", "expired", "payment_failed"],
    ["pending", "cancelled", "payment_failed"],
    ["completed", "pending", "paid"],
    ["completed", "processing", "paid"],
    ["completed", "flagged", "paid"],
    ["completed", "something_new", "paid"],
    ["completed", "completed", "delivered"],
    ["completed", "failed", "delivery_failed"],
    ["completed", "reversed", "delivery_failed"],
    ["completed", "refunding", "refunded"],
    ["completed", "refunded", "refunded"],
    ["refunded", "failed", "refunded"], // a refunded order is never told its payment did not go through
    ["refunded", "pending", "refunded"],
    ["refunded", "refunded", "refunded"],
  ]
  it.each(table)("payment %s / status %s -> %s", (paymentStatus, orderStatus, kind) => {
    expect(classifyStatusOrder({ paymentStatus, orderStatus })).toBe(kind)
  })

  it("any unknown value is still waiting or paid, never a failure notice", () => {
    expect(classifyStatusOrder({ paymentStatus: "weird", orderStatus: "pending" })).toBe("waiting")
    expect(classifyStatusOrder({ paymentStatus: "", orderStatus: "" })).toBe("waiting")
    expect(classifyStatusOrder({ paymentStatus: "weird", orderStatus: "failed" })).toBe("waiting")
  })

  it("is case and whitespace tolerant", () => {
    expect(classifyStatusOrder({ paymentStatus: " Completed ", orderStatus: "COMPLETED" })).toBe("delivered")
  })
})
