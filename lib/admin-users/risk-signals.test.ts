import { describe, it, expect } from "vitest"
import { RISK_THRESHOLDS, computeRiskFlags, parseSignalsResult, signalsRpcArgs, toSignalsView, type RawUserSignals } from "./risk-signals"

const NOW = Date.parse("2026-11-02T12:00:00Z")
const HOUR = 3_600_000
const quiet: RawUserSignals = {
  last_order_at: null, failed_orders: 0, refunds: 0, admin_credits: 0, admin_credit_amount: 0,
  created_at: "2025-01-01T00:00:00Z", wallet_balance: 0, phone_number: "0244111222", phone_verified: true, same_phone_accounts: 1,
}
const codes = (s: Partial<RawUserSignals>) => computeRiskFlags({ ...quiet, ...s }, NOW).map((f) => f.code)

describe("RISK_THRESHOLDS", () => {
  it("are the documented values", () => {
    expect(RISK_THRESHOLDS).toEqual({
      failedOrdersWindowHours: 24, failedOrdersMin: 5,
      refundsWindowHours: 168, refundsMin: 3,
      adminCreditWindowHours: 24, adminCreditsMin: 1,
      newAccountHours: 24, newAccountBalanceMin: 500,
      sharedPhoneAccountsMin: 3,
    })
  })
})

describe("computeRiskFlags", () => {
  it("a quiet account has no flags", () => {
    expect(codes({})).toEqual([])
  })

  it("failed orders: flags at the threshold, not below", () => {
    expect(codes({ failed_orders: 4 })).toEqual([])
    expect(codes({ failed_orders: 5 })).toEqual(["failed_orders"])
    expect(computeRiskFlags({ ...quiet, failed_orders: 7 }, NOW)[0].reason).toBe("7 failed orders in the last 24 hours (flag at 5)")
  })

  it("refunds: 3 in 7 days", () => {
    expect(codes({ refunds: 2 })).toEqual([])
    expect(codes({ refunds: 3 })).toEqual(["refunds"])
    expect(computeRiskFlags({ ...quiet, refunds: 3 }, NOW)[0].reason).toBe("3 refunds in the last 7 days (flag at 3)")
  })

  it("admin credit: any in 24h, with the amount", () => {
    expect(codes({ admin_credits: 1 })).toEqual(["admin_credit"])
    expect(computeRiskFlags({ ...quiet, admin_credits: 1, admin_credit_amount: 250 }, NOW)[0].reason)
      .toBe("Wallet credited by an admin once in the last 24 hours (GHS 250.00)")
    expect(computeRiskFlags({ ...quiet, admin_credits: 2 }, NOW)[0].reason).toBe("Wallet credited by an admin 2 times in the last 24 hours")
  })

  it("new account with a high balance: under 24h old AND balance >= 500", () => {
    const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString()
    expect(codes({ created_at: at(2), wallet_balance: 500 })).toEqual(["new_account_high_balance"])
    expect(codes({ created_at: at(2), wallet_balance: 499.99 })).toEqual([])
    expect(codes({ created_at: at(24), wallet_balance: 10_000 })).toEqual([])
    expect(codes({ created_at: at(0.5), wallet_balance: 600 })).toEqual(["new_account_high_balance"])
    expect(computeRiskFlags({ ...quiet, created_at: at(0.5), wallet_balance: 600 }, NOW)[0].reason).toMatch(/^Account is under an hour old with GHS 600.00/)
    expect(computeRiskFlags({ ...quiet, created_at: at(5.5), wallet_balance: 600 }, NOW)[0].reason).toMatch(/^Account is 5 hours old/)
    // a clock-skewed future signup or an unknown date is not flagged
    expect(codes({ created_at: at(-1), wallet_balance: 600 })).toEqual([])
    expect(codes({ created_at: null, wallet_balance: 600 })).toEqual([])
  })

  it("shared phone: 3 or more accounts on the number (this one included)", () => {
    expect(codes({ same_phone_accounts: 2 })).toEqual([])
    expect(codes({ same_phone_accounts: 3 })).toEqual(["shared_phone"])
    expect(computeRiskFlags({ ...quiet, same_phone_accounts: 4 }, NOW)[0].reason).toBe("4 accounts use the phone number 0244111222 (flag at 3)")
  })

  it("several flags come out in a fixed order", () => {
    expect(codes({ failed_orders: 9, refunds: 9, admin_credits: 1, same_phone_accounts: 9, created_at: new Date(NOW - HOUR).toISOString(), wallet_balance: 900 }))
      .toEqual(["failed_orders", "refunds", "admin_credit", "new_account_high_balance", "shared_phone"])
  })

  it("thresholds can be overridden (the rules read them, not literals)", () => {
    const t = { ...RISK_THRESHOLDS, failedOrdersMin: 2 }
    expect(computeRiskFlags({ ...quiet, failed_orders: 2 }, NOW, t).map((f) => f.code)).toEqual(["failed_orders"])
  })
})

describe("parseSignalsResult / toSignalsView / signalsRpcArgs", () => {
  it("parses numbers given as strings and defaults missing fields", () => {
    const m = parseSignalsResult({ u1: { failed_orders: "6", wallet_balance: "12.50", phone_verified: true }, u2: null })
    expect(m.get("u1")).toMatchObject({ failed_orders: 6, wallet_balance: 12.5, refunds: 0, phone_verified: true, last_order_at: null })
    expect(m.has("u2")).toBe(false)
  })

  it("rejects a non-object", () => {
    expect(() => parseSignalsResult(null)).toThrow()
    expect(() => parseSignalsResult([])).toThrow()
  })

  it("builds the view", () => {
    expect(toSignalsView(undefined, false)).toBeNull()
    expect(toSignalsView({ ...quiet, last_order_at: "2026-11-01T00:00:00Z", failed_orders: 5 }, true, NOW)).toMatchObject({
      lastOrderAt: "2026-11-01T00:00:00Z", phoneVerified: true, phoneBlacklisted: true, flags: [{ code: "failed_orders" }],
    })
  })

  it("passes the windows from the thresholds", () => {
    expect(signalsRpcArgs(["a"])).toEqual({ p_user_ids: ["a"], p_failed_hours: 24, p_refund_hours: 168, p_credit_hours: 24 })
  })
})
