import { describe, it, expect } from "vitest"
import { validateReviewUrl, parseReviewUrl, shouldShowReviewCard } from "./review-prompt"

describe("validateReviewUrl", () => {
  it("accepts Google review links", () => {
    expect(validateReviewUrl("https://g.page/r/abc/review")).toEqual({ ok: true, value: "https://g.page/r/abc/review" })
    expect(validateReviewUrl("  https://search.google.com/local/writereview?placeid=X ")).toEqual({
      ok: true,
      value: "https://search.google.com/local/writereview?placeid=X",
    })
    expect(validateReviewUrl("https://maps.app.goo.gl/xyz").ok).toBe(true)
  })
  it("treats empty as null", () => {
    expect(validateReviewUrl("")).toEqual({ ok: true, value: null })
    expect(validateReviewUrl("   ")).toEqual({ ok: true, value: null })
    expect(validateReviewUrl(null)).toEqual({ ok: true, value: null })
  })
  it("rejects bad links", () => {
    expect(validateReviewUrl("http://g.page/x").ok).toBe(false)
    expect(validateReviewUrl("https://evil.com/g.page").ok).toBe(false)
    expect(validateReviewUrl("javascript:alert(1)").ok).toBe(false)
    expect(validateReviewUrl("https://g.page/" + "a".repeat(500)).ok).toBe(false)
    expect(validateReviewUrl(5).ok).toBe(false)
  })
  it("rejects look-alike hosts, credentials, ports and host-in-query", () => {
    for (const u of [
      "https://g.page.evil.com/x",
      "https://g.page@evil.com/",
      "https://x@g.page/",
      "https://x:y@g.page/",
      "https://g.page:8443/",
      "https://evil.com/?x=g.page",
    ]) {
      expect(validateReviewUrl(u).ok, u).toBe(false)
    }
    expect(validateReviewUrl("https://g.page:443/r/abc").ok).toBe(true)
  })
  it("rejects exactly 501 chars", () => {
    const u = "https://g.page/" + "a".repeat(501 - "https://g.page/".length)
    expect(u.length).toBe(501)
    expect(validateReviewUrl(u).ok).toBe(false)
  })
})

describe("parseReviewUrl", () => {
  it("reads stored JSON string or object", () => {
    expect(parseReviewUrl(JSON.stringify({ url: "https://g.page/r/a/review" }))).toBe("https://g.page/r/a/review")
    expect(parseReviewUrl({ url: "https://g.page/r/a/review" })).toBe("https://g.page/r/a/review")
  })
  it("returns null for junk or disallowed", () => {
    expect(parseReviewUrl(null)).toBeNull()
    expect(parseReviewUrl("not json")).toBeNull()
    expect(parseReviewUrl(JSON.stringify({ url: null }))).toBeNull()
    expect(parseReviewUrl(JSON.stringify({ url: "https://evil.com/x" }))).toBeNull()
  })
})

describe("shouldShowReviewCard", () => {
  const now = new Date("2026-10-29T00:00:00Z")
  const ago = (d: number) => new Date(now.getTime() - d * 86400000).toISOString()
  it("shows with no state", () => expect(shouldShowReviewCard(null, now)).toBe(true))
  it("hides when clicked", () => expect(shouldShowReviewCard({ clicked: true }, now)).toBe(false))
  it("hides 29 days after dismissal", () => expect(shouldShowReviewCard({ dismissedAt: ago(29) }, now)).toBe(false))
  it("shows 31 days after dismissal", () => expect(shouldShowReviewCard({ dismissedAt: ago(31) }, now)).toBe(true))
  it("shows on invalid dismissedAt", () => expect(shouldShowReviewCard({ dismissedAt: "garbage" }, now)).toBe(true))
})
