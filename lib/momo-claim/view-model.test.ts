import { describe, it, expect } from "vitest"
import { buildSendAndClaimView, momoErrorCopy } from "./view-model"

describe("momoErrorCopy", () => {
  const limits = { minNet: 2, maxSent: 500 }
  it("maps known codes to customer copy", () => {
    expect(momoErrorCopy("below_min", limits)).toBe("Amount too small. The minimum after the fee is GHS 2.")
    expect(momoErrorCopy("above_max", limits)).toBe("Amount too large. The maximum per payment is GHS 500.")
    expect(momoErrorCopy("rate_limited", limits)).toBe("Please wait a moment and try again.")
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
