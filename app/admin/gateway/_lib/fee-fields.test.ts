import { describe, it, expect } from "vitest"
import { GATEWAY_PAGE_SETTINGS_KEYS, pickGatewaySettings } from "./fee-fields"

describe("pickGatewaySettings", () => {
  it("keeps only gateway-page keys with finite numbers", () => {
    expect(
      pickGatewaySettings({
        paystack_fee_percentage: 3,
        signups_enabled: true,
        minimum_withdrawal_amount: 5,
        withdrawal_fee_minimum: "x",
      }),
    ).toEqual({ paystack_fee_percentage: 3, minimum_withdrawal_amount: 5 })
  })

  it("drops NaN, Infinity, null and numeric strings", () => {
    expect(
      pickGatewaySettings({
        paystack_fee_percentage: Number.NaN,
        wallet_topup_fee_percentage: Number.POSITIVE_INFINITY,
        withdrawal_fee_percentage: null,
        withdrawal_fee_minimum: "2",
        minimum_withdrawal_amount: 0,
      }),
    ).toEqual({ minimum_withdrawal_amount: 0 })
  })

  it("returns all five keys when all are valid", () => {
    const form = Object.fromEntries(GATEWAY_PAGE_SETTINGS_KEYS.map((k, i) => [k, i + 1]))
    expect(Object.keys(pickGatewaySettings(form)).sort()).toEqual([...GATEWAY_PAGE_SETTINGS_KEYS].sort())
  })

  it("lists exactly the five fee/withdrawal keys", () => {
    expect([...GATEWAY_PAGE_SETTINGS_KEYS]).toEqual([
      "paystack_fee_percentage",
      "wallet_topup_fee_percentage",
      "withdrawal_fee_percentage",
      "withdrawal_fee_minimum",
      "minimum_withdrawal_amount",
    ])
  })
})
