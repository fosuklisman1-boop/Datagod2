import { describe, it, expect } from "vitest"
import { parseListQuery, reasonLabel, previewText, audienceLabel, shortId, pageRange, totalPages, isUuid, PAGE_SIZE } from "./review"

const q = (s: string) => parseListQuery(new URLSearchParams(s))

describe("parseListQuery", () => {
  it("defaults to page 1 with no filters", () => {
    expect(q("")).toEqual({ ok: true, value: { page: 1 } })
  })
  it("parses every filter", () => {
    expect(q("context=storefront&flagged=true&reviewed=false&from=2026-11-01&to=2026-11-20&page=3")).toEqual({
      ok: true,
      value: { context: "storefront", flagged: true, reviewed: false, from: "2026-11-01", to: "2026-11-20", page: 3 },
    })
  })
  it("rejects bad values", () => {
    for (const bad of ["context=admin", "flagged=maybe", "from=yesterday", "page=0", "page=abc", "to=2026-13-45"]) {
      expect(q(bad).ok).toBe(false)
    }
  })
})

describe("labels and truncation", () => {
  it("labels reasons friendly, unknown passes through", () => {
    expect(reasonLabel("handoff")).toBe("Asked for a human")
    expect(reasonLabel("card_failed")).toBe("Confirm card failed")
    expect(reasonLabel("weird")).toBe("weird")
  })
  it("truncates previews to 120 with an ellipsis and collapses whitespace", () => {
    expect(previewText("a  b\n c")).toBe("a b c")
    const out = previewText("x".repeat(300))
    expect(out.length).toBe(120)
    expect(out.endsWith("…")).toBe(true)
    expect(previewText(null)).toBe("")
  })
  it("audience labels never expose identity", () => {
    expect(audienceLabel("home", null, null)).toBe("Public visitor")
    expect(audienceLabel("home", "u1", null)).toBe("Signed-in user")
    expect(audienceLabel("storefront", null, "s1")).toBe("Shop visitor")
    expect(audienceLabel("dashboard", "u1", null)).toBe("Signed-in user")
  })
  it("shortId is 8 chars; isUuid validates", () => {
    expect(shortId("12345678-aaaa-bbbb-cccc-1234567890ab")).toBe("12345678")
    expect(shortId(null)).toBe("")
    expect(isUuid("12345678-aaaa-4bbb-8ccc-1234567890ab")).toBe(true)
    expect(isUuid("nope")).toBe(false)
  })
})

describe("pagination", () => {
  it("computes ranges and page counts", () => {
    expect(PAGE_SIZE).toBe(25)
    expect(pageRange(1)).toEqual({ from: 0, to: 24 })
    expect(pageRange(3)).toEqual({ from: 50, to: 74 })
    expect(totalPages(0)).toBe(1)
    expect(totalPages(25)).toBe(1)
    expect(totalPages(26)).toBe(2)
  })
})
