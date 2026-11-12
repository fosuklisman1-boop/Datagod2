import { describe, it, expect } from "vitest"
import { buildSendAndClaimView, momoErrorCopy, formatGhs, limitsLine, pausedPanelCopy, beforeYouSendLines } from "./view-model"
import { MAX_OPEN_SESSIONS, WINDOW_MINUTES } from "./window"

describe("formatGhs", () => {
  it("drops decimals for whole amounts and adds thousands separators", () => {
    expect(formatGhs(10000)).toBe("GH₵ 10,000")
    expect(formatGhs(2000)).toBe("GH₵ 2,000")
  })
  it("keeps 2 decimals otherwise", () => {
    expect(formatGhs(2000.5)).toBe("GH₵ 2,000.50")
    expect(formatGhs(10.25)).toBe("GH₵ 10.25")
  })
  it("can force 2 decimals", () => {
    expect(formatGhs(10, { fixed: true })).toBe("GH₵ 10.00")
  })
})

describe("limitsLine", () => {
  it("formats min with 2dp and max compactly", () => {
    expect(limitsLine({ minNet: 10, maxSent: 10000 })).toBe("Minimum GH₵ 10.00 · Maximum GH₵ 10,000")
  })
})

describe("beforeYouSendLines", () => {
  it("uses the window minutes and limits", () => {
    const l = beforeYouSendLines({ minNet: 10, maxSent: 10000 })
    expect(l.window).toContain(`${WINDOW_MINUTES} minutes`)
    expect(l.between).toBe("Send between GH₵ 10.00 and GH₵ 10,000.")
  })
})

describe("pausedPanelCopy", () => {
  it("offers Send & Claim when enabled", () => {
    const c = pausedPanelCopy(true)
    expect(c.title).toBe("Top-ups are paused")
    expect(c.text).toBe(
      "Card and MoMo top-ups are temporarily unavailable. You can still fund your wallet instantly with Send & Claim.",
    )
    expect(c.showButton).toBe(true)
  })
  it("says check back soon when Send & Claim is off", () => {
    const c = pausedPanelCopy(false)
    expect(c.text).toBe("Card and MoMo top-ups are temporarily unavailable. Please check back soon.")
    expect(c.showButton).toBe(false)
  })
})

describe("momoErrorCopy", () => {
  const limits = { minNet: 2, maxSent: 500 }
  it("maps remaining codes to customer copy", () => {
    expect(momoErrorCopy("phone_not_verified", limits)).toBe("Verify your phone number to use Send & Claim.")
    expect(momoErrorCopy("no_wallet", limits)).toBe("Your wallet isn't ready yet. Refresh the page or contact support.")
    expect(momoErrorCopy("invalid", limits)).toBe("Enter a valid amount (up to 2 decimals).")
    expect(momoErrorCopy("too_many_open", limits)).toBe(
      `You have ${MAX_OPEN_SESSIONS} open payments. A new one unlocks when one expires or is credited.`,
    )
  })
  it("maps known codes to customer copy", () => {
    expect(momoErrorCopy("below_min", limits)).toBe("Amount too small. The minimum after the fee is GHS 2.00.")
    expect(momoErrorCopy("above_max", limits)).toBe("Amount too large. The maximum per payment is GHS 500.00.")
    expect(momoErrorCopy("rate_limited", limits)).toBe("Please wait a moment and try again.")
  })
  it("maps feature_off", () => {
    expect(momoErrorCopy("feature_off", limits)).toBe("Send & Claim is not available right now.")
  })
  it("falls back for unknown codes", () => {
    expect(momoErrorCopy("weird", limits)).toMatch(/try again/)
  })
})

const now = new Date("2026-11-11T12:00:00Z")
const mk = (id: string, minsAgo: number, status = "pending", ttlMin = 60) => ({
  id,
  status,
  createdAt: new Date(now.getTime() - minsAgo * 60000).toISOString(),
  expiresAt: new Date(now.getTime() - minsAgo * 60000 + ttlMin * 60000).toISOString(),
})

describe("buildSendAndClaimView", () => {
  it("hides claim boxes while the payment modal is open", () => {
    const v = buildSendAndClaimView([mk("a", 5)], now, true, false)
    expect(v.boxes).toEqual([])
  })

  it("shows one box per open session, newest first", () => {
    const v = buildSendAndClaimView(
      [mk("old", 30), mk("new", 5), mk("done", 10, "claimed"), mk("exp", 90)],
      now,
      false,
      false,
    )
    expect(v.boxes.map((b) => b.id)).toEqual(["new", "old"])
  })

  it("keeps generate enabled below 5 open sessions", () => {
    const v = buildSendAndClaimView([mk("a", 1), mk("b", 2)], now, false, false)
    expect(v.generateDisabled).toBe(false)
    expect(v.nextSlotFreeAt).toBeNull()
  })

  it("disables generate at 5 open sessions with the earliest expiry as target", () => {
    const sessions = [mk("a", 50), mk("b", 40), mk("c", 30), mk("d", 20), mk("e", 10)]
    const v = buildSendAndClaimView(sessions, now, false, false)
    expect(v.generateDisabled).toBe(true)
    expect(v.nextSlotFreeAt?.toISOString()).toBe(new Date(now.getTime() + 10 * 60000).toISOString())
  })

  it("keeps the guide open until the first credited claim", () => {
    expect(buildSendAndClaimView([], now, false, false).guideOpenByDefault).toBe(true)
    expect(buildSendAndClaimView([], now, false, true).guideOpenByDefault).toBe(false)
  })
})
