import { describe, it, expect } from "vitest"
import {
  formatCount, formatGhs, formatPerSms, maskIdCard, waLink, statusTone, toneClass, statusLabel, timeAgo, pageInfo,
  messageBreakdown, accountCredits, groupReviews, bannerFor, previewTotals, tabFromParam, TAB_IDS, parseList, providerLabel, supplyHeadline,
  shouldResetPage, formatRate,
} from "./view"

describe("numbers and money", () => {
  it("formatCount", () => {
    expect(formatCount(7111)).toBe("7,111")
    expect(formatCount("1234567")).toBe("1,234,567")
    expect(formatCount(null)).toBe("0")
    expect(formatCount(12.9)).toBe("12")
  })
  it("formatGhs", () => {
    expect(formatGhs(191.5)).toBe("GH₵191.50")
    expect(formatGhs("1234.567")).toBe("GH₵1,234.57")
    expect(formatGhs(undefined)).toBe("GH₵0.00")
    expect(formatGhs(-5)).toBe("-GH₵5.00")
  })
  it("formatPerSms trims trailing zeros and guards zero units", () => {
    expect(formatPerSms(35, 1000)).toBe("GH₵0.035")
    expect(formatPerSms(150, 5000)).toBe("GH₵0.03")
    expect(formatPerSms(10, 10)).toBe("GH₵1")
    expect(formatPerSms(10, 0)).toBe("—")
    expect(formatPerSms(10, -5)).toBe("—")
  })
  it("formatRate trims trailing zeros", () => {
    expect(formatRate(0.035)).toBe("GH₵0.035")
    expect(formatRate(0.03)).toBe("GH₵0.03")
    expect(formatRate(1)).toBe("GH₵1")
    expect(formatRate(0.0349999)).toBe("GH₵0.035")
    expect(formatRate(null)).toBe("—")
    expect(formatRate(undefined)).toBe("—")
  })
})

describe("ID card and WhatsApp", () => {
  it("maskIdCard shows only the last 4", () => {
    expect(maskIdCard("7890")).toBe("ID ending 7890")
    expect(maskIdCard(null)).toBe("—")
    expect(maskIdCard("12")).toBe("—")
  })
  it("waLink normalises Ghana numbers", () => {
    expect(waLink("0241234567")).toBe("https://wa.me/233241234567")
    expect(waLink("233241234567")).toBe("https://wa.me/233241234567")
    expect(waLink("+233 24 123 4567")).toBe("https://wa.me/233241234567")
    expect(waLink("123")).toBeNull()
    expect(waLink(null)).toBeNull()
  })
})

describe("status helpers", () => {
  it("statusTone", () => {
    expect(statusTone("sent")).toBe("success")
    expect(statusTone("Active")).toBe("success")
    expect(statusTone("submitted")).toBe("warning")
    expect(statusTone("failed")).toBe("danger")
    expect(statusTone("whatever")).toBe("neutral")
  })
  it("toneClass returns distinct classes", () => {
    const set = new Set((["success", "warning", "danger", "neutral"] as const).map(toneClass))
    expect(set.size).toBe(4)
  })
  it("statusLabel", () => {
    expect(statusLabel("submitted")).toBe("Under review")
    expect(statusLabel("inactive")).toBe("Not activated")
    expect(statusLabel("partial")).toBe("Partial")
    expect(statusLabel("kyc_free")).toBe("Kyc free")
  })
})

describe("timeAgo / pageInfo", () => {
  const now = Date.parse("2026-10-11T12:00:00Z")
  it("timeAgo", () => {
    expect(timeAgo("2026-10-11T11:59:50Z", now)).toBe("just now")
    expect(timeAgo("2026-10-11T11:55:00Z", now)).toBe("5 min ago")
    expect(timeAgo("2026-10-11T09:00:00Z", now)).toBe("3 h ago")
    expect(timeAgo("2026-10-09T12:00:00Z", now)).toBe("2 d ago")
    expect(timeAgo("2026-05-01T12:00:00Z", now)).toBe("2026-05-01")
    expect(timeAgo(null, now)).toBe("—")
    expect(timeAgo("junk", now)).toBe("—")
  })
  it("timeAgo boundaries", () => {
    expect(timeAgo("2026-10-11T11:59:01Z", now)).toBe("just now") // 59s
    expect(timeAgo("2026-10-11T11:59:00Z", now)).toBe("1 min ago") // 60s
    expect(timeAgo("2026-10-11T11:00:01Z", now)).toBe("59 min ago")
    expect(timeAgo("2026-10-11T11:00:00Z", now)).toBe("1 h ago")
    expect(timeAgo("2026-10-10T12:00:01Z", now)).toBe("23 h ago")
    expect(timeAgo("2026-10-10T12:00:00Z", now)).toBe("1 d ago")
    expect(timeAgo("2026-09-12T12:00:00Z", now)).toBe("29 d ago")
    expect(timeAgo("2026-09-11T12:00:00Z", now)).toBe("2026-09-11")
  })
  it("timeAgo future timestamps", () => {
    expect(timeAgo("2026-10-11T12:05:00Z", now)).toBe("soon")
  })
  it("pageInfo", () => {
    expect(pageInfo(1, 25, 0)).toEqual({ pages: 1, from: 0, to: 0 })
    expect(pageInfo(2, 25, 57)).toEqual({ pages: 3, from: 26, to: 50 })
    expect(pageInfo(3, 25, 57)).toEqual({ pages: 3, from: 51, to: 57 })
  })
  it("shouldResetPage only when past page 1 with no rows", () => {
    expect(shouldResetPage(2, 0)).toBe(true)
    expect(shouldResetPage(5, 0)).toBe(true)
    expect(shouldResetPage(1, 0)).toBe(false)
    expect(shouldResetPage(2, 3)).toBe(false)
    expect(shouldResetPage(1, 3)).toBe(false)
  })
})

describe("row summaries", () => {
  it("messageBreakdown only when delivery is tracked", () => {
    expect(messageBreakdown({ tracked: 0, delivered: 0, failed: 0, pending: 0 })).toBeNull()
    expect(messageBreakdown({ tracked: "10", delivered: "7", failed: "1", pending: "2" })).toBe("7 delivered · 1 failed · 2 pending")
  })
  it("accountCredits", () => expect(accountCredits({ bought: 2000, used: "345" })).toBe("2,000 bought · 345 used"))
  it("groupReviews", () => {
    const g = groupReviews([{ status: "submitted" }, { status: "approved" }, { status: "rejected" }, { status: "draft" }, { status: "submitted" }])
    expect(g.pending).toHaveLength(2); expect(g.approved).toHaveLength(1); expect(g.rejected).toHaveLength(1)
  })
})

describe("banner / supply / preview", () => {
  const ok = { featureEnabled: true, provider: "moolre", supply: { backedCredits: 100 } }
  it("bannerFor: live, paused, supply-warning", () => {
    expect(bannerFor(ok)).toEqual({ tone: "success", text: "Live — customers can buy credits and send SMS" })
    expect(bannerFor({ ...ok, featureEnabled: false }).tone).toBe("danger")
    const w = bannerFor({ ...ok, supply: { backedCredits: 0, error: "Hubtel balance unavailable: x" } })
    expect(w.tone).toBe("warning")
    expect(w.text).toContain("Hubtel balance unavailable: x")
  })
  it("bannerFor: zero backed supply warns, positive unchanged, paused/error take priority", () => {
    expect(bannerFor({ ...ok, supply: { backedCredits: 0 } })).toEqual({ tone: "warning", text: "Live — but credit sales are paused: no backed supply" })
    expect(bannerFor({ ...ok, supply: { backedCredits: 1 } }).tone).toBe("success")
    expect(bannerFor({ ...ok, featureEnabled: false, supply: { backedCredits: 0 } }).tone).toBe("danger")
    expect(bannerFor({ ...ok, supply: { backedCredits: 0, error: "e" } }).text).toContain("e")
  })
  it("supplyHeadline + providerLabel", () => {
    expect(providerLabel("hubtel")).toBe("Hubtel")
    expect(providerLabel("moolre")).toBe("Moolre")
    expect(supplyHeadline({ backedCredits: 1200 })).toBe("1,200 credits backed")
    expect(supplyHeadline({ backedCredits: 0, error: "relay down" })).toBe("Supply unknown — relay down")
  })
  it("previewTotals sums by decision", () => {
    const t = previewTotals([{ decision: "allow", code: "OK", count: 10 }, { decision: "block", code: "LINK_NOT_ALLOWED", count: 3 }, { decision: "reject", code: "CAP_PER_SEND", count: 2 }, { decision: "error", code: "ERROR", count: 1 }])
    expect(t.total).toBe(16)
    expect(t.byDecision).toEqual({ allow: 10, block: 3, reject: 2, error: 1 })
  })
})

describe("tabs and lists", () => {
  it("tabFromParam", () => {
    expect(TAB_IDS).toHaveLength(7)
    expect(tabFromParam("accounts")).toBe("accounts")
    expect(tabFromParam("nope")).toBe("business-reviews")
    expect(tabFromParam(null)).toBe("business-reviews")
  })
  it("parseList splits on commas/newlines, trims, de-dupes case-insensitively", () => {
    expect(parseList("loan, Win Big\nLOAN ,, promo ")).toEqual(["loan", "Win Big", "promo"])
    expect(parseList("")).toEqual([])
  })
})
