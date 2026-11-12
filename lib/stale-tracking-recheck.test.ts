import { describe, it, expect } from "vitest"
import { classifyRecheck, redactPhoneNumbers } from "./stale-tracking-recheck"

describe("redactPhoneNumbers", () => {
  it("masks local and international phone numbers in a provider message", () => {
    expect(redactPhoneNumbers("These numbers appear more than once: 0530191982, 233533027123")).toBe(
      "These numbers appear more than once: ***1982, ***7123"
    )
  })

  it("leaves short numbers (sizes, codes) and null alone", () => {
    expect(redactPhoneNumbers("1GB order already active (ref BULK_API_D5AE086F30)")).toBe(
      "1GB order already active (ref BULK_API_D5AE086F30)"
    )
    expect(redactPhoneNumbers(null)).toBeNull()
  })
})

describe("classifyRecheck", () => {
  it("confirms completed only when the provider call succeeded and says completed", () => {
    expect(classifyRecheck({ success: true, status: "completed" })).toBe("confirm_completed")
  })

  it("confirms failed only when the provider call succeeded and says failed", () => {
    expect(classifyRecheck({ success: true, status: "failed" })).toBe("confirm_failed")
  })

  it.each([
    [{ success: true, status: "processing", message: "Order in flight (not yet found in order listing)" }],
    [{ success: true, status: "pending" }],
    [{ success: false, message: "Service temporarily unavailable" }],
    [{ success: false, status: "completed" }], // a failed call never counts as an answer
    [{ success: true }], // no status
  ])("everything else is unresolved: %o", (r) => {
    expect(classifyRecheck(r)).toBe("unresolved")
  })
})
