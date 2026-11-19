import { describe, it, expect } from "vitest"
import { describeShopProfit, formatSignedGhs } from "./shop-profit-label"

describe("describeShopProfit", () => {
  it("describes a storefront data order from the joined shop_orders row", () => {
    expect(
      describeShopProfit({ shop_order_id: "x", shop_orders: { network: "MTN", volume_gb: 2, customer_name: "Ama" } }),
    ).toBe("MTN 2GB — Ama")
  })

  it("falls back to 'Customer' when the data order has no name", () => {
    expect(describeShopProfit({ shop_orders: { network: "AT", volume_gb: 1, customer_name: null } })).toBe("AT 1GB — Customer")
  })

  it.each([
    [{ bill_order_id: "b", notes: "Cashback share" }, "Bill payment commission"],
    [{ data_order_id: "d", notes: "Cashback share" }, "Bundle commission"],
    [{ airtime_order_id: "a" }, "Airtime commission"],
    [{ results_checker_order_id: "r" }, "Results checker commission"],
    [{ results_check_request_id: "r" }, "Results check commission"],
    [{ ussd_shop_order_id: "u" }, "USSD shop sale"],
    [{ ussd_order_id: "u" }, "Sub-agent USSD sale"],
  ])("labels commission/service rows by their order link: %o", (row, label) => {
    expect(describeShopProfit(row)).toBe(label)
  })

  it("uses the stored description or notes for adjustments with no order link", () => {
    expect(describeShopProfit({ refund_id: "r", notes: "Order refund reversal" })).toBe("Order refund reversal")
    expect(describeShopProfit({ description: "Wallet debt recovery (negative balance adjustment)" })).toBe(
      "Wallet debt recovery (negative balance adjustment)",
    )
    expect(describeShopProfit({ adjustment_type: "manual", notes: "Manual Debit by admin" })).toBe("Manual Debit by admin")
  })

  it("labels a refund row without text as a refund adjustment", () => {
    expect(describeShopProfit({ refund_id: "r" })).toBe("Refund adjustment")
  })

  it("falls back to 'Order profit' when nothing identifies the row", () => {
    expect(describeShopProfit({})).toBe("Order profit")
    expect(describeShopProfit({ notes: "   " })).toBe("Order profit")
  })
})

describe("formatSignedGhs", () => {
  it("prefixes credits with + and debits with -, never '+-'", () => {
    expect(formatSignedGhs(1.5, "+")).toBe("+GH₵1.50")
    expect(formatSignedGhs(-1, "+")).toBe("-GH₵1.00")
  })

  it("keeps the outgoing sign for withdrawals/expenses", () => {
    expect(formatSignedGhs(20, "-")).toBe("-GH₵20.00")
  })
})
