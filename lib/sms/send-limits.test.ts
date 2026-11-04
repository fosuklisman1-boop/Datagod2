import { describe, it, expect } from "vitest"
import { effectivePerSend, SMS_HARD_MAX_PER_SEND } from "./send-limits"

const withCaps = (platform: number, business: number) => ({
  caps: {
    platform: { per_send: platform, per_hour: 1, per_day: 1 },
    business: { per_send: business, per_hour: 1, per_day: 1 },
  },
})

describe("effectivePerSend", () => {
  it("is the admin per-send cap for the account's mode", () => {
    const s = withCaps(2000, 3000)
    expect(effectivePerSend(s, "platform")).toBe(2000)
    expect(effectivePerSend(s, "business")).toBe(3000)
  })
  it("never exceeds the system ceiling (one request batches at most 5,000)", () => {
    expect(SMS_HARD_MAX_PER_SEND).toBe(5000)
    expect(effectivePerSend(withCaps(2000, 10000), "business")).toBe(5000)
  })
  it("treats a missing/unknown mode as platform", () => {
    expect(effectivePerSend(withCaps(2000, 3000), undefined)).toBe(2000)
  })
})
