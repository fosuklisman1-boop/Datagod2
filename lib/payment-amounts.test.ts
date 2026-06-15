import { netCreditAmount } from "@/lib/payment-amounts"

describe("netCreditAmount", () => {
  it("uses the authoritative payment_attempts net amount when present", () => {
    expect(netCreditAmount(95, 100, 5)).toBe(95)
  })

  it("uses a zero attempt amount instead of falling through (?? not ||)", () => {
    // A real attempt row of 0 must win; `|| ` would wrongly fall through to gross-fee.
    expect(netCreditAmount(0, 100, 5)).toBe(0)
  })

  it("falls back to gross - fee when there is no attempt row", () => {
    expect(netCreditAmount(null, 100, 5)).toBe(95)
    expect(netCreditAmount(undefined, 100, 5)).toBe(95)
  })

  it("treats a missing/null fee as zero in the fallback", () => {
    expect(netCreditAmount(null, 100, null)).toBe(100)
    expect(netCreditAmount(undefined, 100, undefined)).toBe(100)
  })

  it("does NOT over-credit the gross when a fee exists and no attempt row (the bug we fixed)", () => {
    // gross 103 includes a 3 fee → must credit 100, never 103.
    expect(netCreditAmount(undefined, 103, 3)).toBe(100)
  })

  it("handles a zero gross without falling through", () => {
    expect(netCreditAmount(undefined, 0, 0)).toBe(0)
  })
})
