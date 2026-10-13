import { describe, it, expect } from "vitest"
import { purchaseMethod, walletShortfall, buyBlockedReason, buyErrorMessage, purchaseOutcome, formatDelta } from "./view"

describe("credits helpers", () => {
  it("purchaseMethod picks wallet only when it covers the price", () => {
    expect(purchaseMethod(10, 10)).toBe("wallet")
    expect(purchaseMethod(9.99, 10)).toBe("paystack")
  })
  it("walletShortfall", () => {
    expect(walletShortfall(4, 10)).toBe(6)
    expect(walletShortfall(20, 10)).toBe(0)
    expect(walletShortfall(0.1, 0.3)).toBe(0.2)
  })
  it("buyBlockedReason", () => {
    expect(buyBlockedReason({ featureEnabled: false, status: "active" })).toMatch(/unavailable/)
    expect(buyBlockedReason({ featureEnabled: true, status: "suspended" })).toMatch(/suspended/)
    expect(buyBlockedReason({ featureEnabled: true, status: "inactive" })).toMatch(/Activate/)
    expect(buyBlockedReason({ featureEnabled: true, status: "active" })).toBeNull()
  })
  it("buyErrorMessage maps known errors", () => {
    expect(buyErrorMessage("x", "SMS_DISABLED")).toMatch(/temporarily unavailable/)
    expect(buyErrorMessage("Insufficient wallet balance")).toMatch(/Paystack/)
    expect(buyErrorMessage("NOT_ACTIVATED")).toBe("Activate your SMS account first.")
    expect(buyErrorMessage("Bundle not available")).toBe("Bundle not available")
  })
  it("purchaseOutcome", () => {
    expect(purchaseOutcome({ authorizationUrl: "https://p/x" })).toEqual({ kind: "redirect", url: "https://p/x" })
    expect(purchaseOutcome({ pending: true }).kind).toBe("pending")
    expect(purchaseOutcome({}).kind).toBe("success")
  })
  it("formatDelta", () => {
    expect(formatDelta(1200)).toBe("+1,200")
    expect(formatDelta(-5)).toBe("−5")
  })
})
