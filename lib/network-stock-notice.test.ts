import { describe, it, expect } from "vitest"
import {
  STOCK_REASON_MAX,
  normalizeStockReason,
  stockNetworkKey,
  stockNetworkLabel,
  buildStockNotices,
  noticeFor,
  noticeWhenEmpty,
} from "./network-stock-notice"

describe("normalizeStockReason", () => {
  it("collapses newlines and extra spaces into one line", () => {
    expect(normalizeStockReason("  MTN delays,\n back by 6pm  ")).toBe("MTN delays, back by 6pm")
  })
  it("strips angle brackets so no markup survives", () => {
    expect(normalizeStockReason("<b>hi</b>")).toBe("bhi/b")
  })
  it("returns null for blank or non-text input", () => {
    expect(normalizeStockReason("   ")).toBeNull()
    expect(normalizeStockReason(42)).toBeNull()
    expect(normalizeStockReason(null)).toBeNull()
    expect(normalizeStockReason(undefined)).toBeNull()
  })
  it("caps the reason at 100 characters", () => {
    expect(STOCK_REASON_MAX).toBe(100)
    expect(normalizeStockReason("x".repeat(300))!.length).toBe(100)
  })
  it("keeps emoji intact", () => {
    expect(normalizeStockReason("Back soon 🙏")).toBe("Back soon 🙏")
  })
})

describe("stockNetworkKey / stockNetworkLabel", () => {
  it("matches USSD and DB spellings of AT networks", () => {
    expect(stockNetworkKey("AT-iShare")).toBe(stockNetworkKey("AT - iShare"))
    expect(stockNetworkKey("AT-BigTime")).toBe(stockNetworkKey("AT - BigTime"))
    expect(stockNetworkKey("MTN")).not.toBe(stockNetworkKey("Telecel"))
  })
  it("gives customer labels", () => {
    expect(stockNetworkLabel("AT - iShare")).toBe("AT iShare")
    expect(stockNetworkLabel("AT-BigTime")).toBe("AT BigTime")
    expect(stockNetworkLabel("MTN")).toBe("MTN")
    expect(stockNetworkLabel("Other")).toBe("Other")
  })
})

describe("buildStockNotices / noticeFor", () => {
  it("uses the default text when no reason is set, and skips in-stock networks", () => {
    expect(
      buildStockNotices({ MTN: { outOfStock: true, restoreIds: [] }, Telecel: { outOfStock: false } })
    ).toEqual({ MTN: "MTN bundles are temporarily unavailable. Please check back soon." })
  })
  it("uses the admin reason and matches across spellings", () => {
    const notices = buildStockNotices({ "AT - iShare": { outOfStock: true, reason: "Back at 6pm" } })
    expect(notices).toEqual({ "AT - iShare": "Back at 6pm" })
    expect(noticeFor(notices, "AT-iShare")).toBe("Back at 6pm")
    expect(noticeFor(notices, "MTN")).toBeNull()
  })
  it("noticeWhenEmpty shows the reason only when nothing is on sale", () => {
    const notices = { MTN: "Back soon" }
    expect(noticeWhenEmpty(notices, "MTN", 0)).toBe("Back soon")
    expect(noticeWhenEmpty(notices, "MTN", 2)).toBeNull()
    expect(noticeWhenEmpty(notices, "Telecel", 0)).toBeNull()
  })
  it("treats a malformed map as empty", () => {
    expect(buildStockNotices(null as any)).toEqual({})
    expect(buildStockNotices({ MTN: null } as any)).toEqual({})
  })
})
