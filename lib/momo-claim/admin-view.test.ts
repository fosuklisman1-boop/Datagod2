import { describe, it, expect } from "vitest"
import {
  flagReasonLabel,
  flagReasonsText,
  rowActions,
  formatGhs,
  adminErrorMessage,
  csvHeaderColumns,
  inclusiveSpanDays,
  isReviewOnlyFlag,
  actionNeedsReason,
} from "./admin-view"

describe("flag reasons", () => {
  it("maps known reasons to plain words", () => {
    expect(flagReasonLabel("first_claim")).toBe("first claim")
    expect(flagReasonLabel("txid_regression")).toBe("old transaction ID")
    expect(flagReasonLabel("balance_repeat")).toBe("repeated balance")
    expect(flagReasonLabel("above_review_threshold")).toBe("large amount")
    expect(flagReasonLabel("auto_credit_error")).toBe("auto-credit error")
  })
  it("never shows raw codes for unknown reasons", () => {
    expect(flagReasonLabel("weird_code_9")).toBe("other")
  })
  it("joins, tolerating null/empty", () => {
    expect(flagReasonsText(["first_claim", "daily_cap"])).toBe("first claim, daily cap reached")
    expect(flagReasonsText(null)).toBe("")
    expect(flagReasonsText([])).toBe("")
  })
})

describe("isReviewOnlyFlag", () => {
  it("true when every reason is a review-type reason", () => {
    expect(isReviewOnlyFlag(["first_claim"])).toBe(true)
    expect(isReviewOnlyFlag(["first_claim", "above_review_threshold", "daily_cap"])).toBe(true)
  })
  it("false when any suspicious reason is present or list empty", () => {
    expect(isReviewOnlyFlag(["first_claim", "amount_mismatch"])).toBe(false)
    expect(isReviewOnlyFlag([])).toBe(false)
    expect(isReviewOnlyFlag(null)).toBe(false)
  })
})

describe("rowActions", () => {
  it("pending -> void only", () => {
    expect(rowActions("pending", []).map((a) => a.action)).toEqual(["void"])
  })
  it("unparsed -> void, assign", () => {
    expect(rowActions("unparsed", null).map((a) => a.action)).toEqual(["void", "assign"])
  })
  it("voided -> restore", () => {
    expect(rowActions("voided", null).map((a) => a.action)).toEqual(["restore"])
  })
  it("claimed / rejected_sender -> none", () => {
    expect(rowActions("claimed", null)).toEqual([])
    expect(rowActions("rejected_sender", null)).toEqual([])
  })
  it("flagged -> credit, assign, unflag with credit primary for review-only flags", () => {
    const a = rowActions("flagged", ["first_claim"])
    expect(a.map((x) => x.action)).toEqual(["credit", "assign", "unflag"])
    expect(a[0].primary).toBe(true)
    expect(a.find((x) => x.action === "unflag")?.hint).toMatch(/re-flag/i)
  })
  it("flagged for suspicious reasons -> no primary, no unflag hint", () => {
    const a = rowActions("flagged", ["amount_mismatch"])
    expect(a.some((x) => x.primary)).toBe(false)
    expect(a.find((x) => x.action === "unflag")?.hint).toBeUndefined()
  })
  it("labels are readable", () => {
    expect(rowActions("flagged", []).map((x) => x.label)).toEqual(["Approve & credit", "Assign to user", "Unflag"])
  })
})

describe("actionNeedsReason", () => {
  it("unflag, credit, assign need one", () => {
    expect(actionNeedsReason("unflag")).toBe(true)
    expect(actionNeedsReason("credit")).toBe(true)
    expect(actionNeedsReason("assign")).toBe(true)
    expect(actionNeedsReason("void")).toBe(false)
    expect(actionNeedsReason("restore")).toBe(false)
  })
})

describe("formatGhs", () => {
  it("always 2 decimals", () => {
    expect(formatGhs(5)).toBe("GHS 5.00")
    expect(formatGhs(12.3)).toBe("GHS 12.30")
    expect(formatGhs("7.456")).toBe("GHS 7.46")
  })
  it("dash for missing/invalid", () => {
    expect(formatGhs(null)).toBe("-")
    expect(formatGhs(undefined)).toBe("-")
    expect(formatGhs("abc")).toBe("-")
  })
})

describe("adminErrorMessage", () => {
  it("maps API codes", () => {
    expect(adminErrorMessage("no_linked_session")).toMatch(/no linked/i)
    expect(adminErrorMessage("invalid_state")).toMatch(/changed/i)
    expect(adminErrorMessage("settings_unavailable")).toMatch(/saving is disabled/i)
    expect(adminErrorMessage("run_not_saved")).toMatch(/not saved/i)
    expect(adminErrorMessage("mtn_account_required")).toMatch(/MTN/)
  })
  it("never echoes unknown text", () => {
    expect(adminErrorMessage("SELECT * FROM secrets")).toBe("Something went wrong. Please try again.")
    expect(adminErrorMessage(undefined)).toBe("Something went wrong. Please try again.")
  })
})

describe("csvHeaderColumns", () => {
  it("splits first line, trims quotes and blanks", () => {
    expect(csvHeaderColumns('Date,"Transaction ID", Amount ,\n1,2,3')).toEqual(["Date", "Transaction ID", "Amount"])
  })
  it("handles CRLF and BOM", () => {
    expect(csvHeaderColumns("﻿A,B\r\n1,2")).toEqual(["A", "B"])
  })
  it("empty input -> []", () => {
    expect(csvHeaderColumns("")).toEqual([])
  })
})

describe("inclusiveSpanDays", () => {
  it("same day is 1", () => {
    expect(inclusiveSpanDays("2026-11-01", "2026-11-01")).toBe(1)
  })
  it("counts both ends", () => {
    expect(inclusiveSpanDays("2026-11-01", "2026-11-30")).toBe(30)
    expect(inclusiveSpanDays("2026-09-01", "2026-11-01")).toBe(62)
  })
  it("null on bad input", () => {
    expect(inclusiveSpanDays("", "2026-11-01")).toBeNull()
    expect(inclusiveSpanDays("nope", "2026-11-01")).toBeNull()
  })
})
