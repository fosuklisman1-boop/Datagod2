import { describe, expect, it } from "vitest"
import { isOtpRequiredReply, walletTopupDisplay } from "./wallet-topup-display"

describe("walletTopupDisplay", () => {
  it("Paystack: unchanged wording, percentage fee, total on the button", () => {
    const d = walletTopupDisplay({ amount: 100, gateway: "paystack", paystackFeePercent: 3 })
    expect(d.description).toBe("Add funds to your wallet using Paystack")
    expect(d.feeLabel).toBe("Paystack Fee (3%):")
    expect(d.feeValue).toBe("GHS 3.00")
    expect(d.totalLabel).toBe("Total Amount:")
    expect(d.totalValue).toBe("GHS 103.00")
    expect(d.feeNote).toBe("The 3% fee is charged by Paystack for payment processing.")
    expect(d.payButton).toBe("Pay GHS 103.00")
  })

  // Live 2026-11-05: Hubtel charged 0.01 on 1.00 and 0.10 on 5.00, so no percentage is promised.
  it("Hubtel: names Hubtel, promises no percentage, and never shows a Paystack fee", () => {
    const d = walletTopupDisplay({ amount: 5, gateway: "hubtel", paystackFeePercent: 3 })
    expect(d.description).toBe("Add funds to your wallet using Mobile Money with Hubtel")
    expect(d.feeLabel).toBe("Hubtel Fee:")
    expect(d.feeValue).toBe("Added at payment")
    expect(d.totalLabel).toBe("Total Amount:")
    expect(d.totalValue).toBe("GHS 5.00 + fee")
    expect(d.feeNote).toBe("Hubtel adds its fee on top. Check the total on your MoMo prompt before you approve.")
    expect(d.payButton).toBe("Pay GHS 5.00 + fee")
    expect(JSON.stringify(d)).not.toMatch(/paystack|3%/i)
  })

  it("an empty or bad amount reads as zero", () => {
    for (const amount of [0, Number.NaN]) {
      expect(walletTopupDisplay({ amount, gateway: "hubtel", paystackFeePercent: 3 }).payButton).toBe("Pay GHS 0.00 + fee")
      expect(walletTopupDisplay({ amount, gateway: "paystack", paystackFeePercent: 3 }).payButton).toBe("Pay GHS 0.00")
    }
  })
})

describe("isOtpRequiredReply", () => {
  it("only the 403 with the OTP_REQUIRED code", () => {
    expect(isOtpRequiredReply(403, { code: "OTP_REQUIRED" })).toBe(true)
    expect(isOtpRequiredReply(403, { code: "OTHER" })).toBe(false)
    expect(isOtpRequiredReply(403, {})).toBe(false)
    expect(isOtpRequiredReply(500, { code: "OTP_REQUIRED" })).toBe(false)
    expect(isOtpRequiredReply(403, null)).toBe(false)
  })
})
