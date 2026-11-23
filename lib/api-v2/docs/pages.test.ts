import { describe, it, expect } from "vitest"
import { v2DocsRegistry as reg } from "./registry"
import {
  DOC_PAGES,
  HUB_SECTION_IDS,
  docPath,
  pageSlugForSection,
  sectionsForPage,
  sectionHref,
  endpointHref,
} from "./pages"
import { errorCode, errorAnchor } from "./error-key"

describe("page map", () => {
  it("every registry section id belongs to exactly one of HUB_SECTION_IDS or one DOC_PAGES.sectionIds; no id appears twice", () => {
    const all = [...HUB_SECTION_IDS, ...DOC_PAGES.flatMap((p) => p.sectionIds)]
    expect(new Set(all).size).toBe(all.length)
    expect([...all].sort()).toEqual(reg.map((s) => s.id).sort())
  })
  it('HUB_SECTION_IDS equals the registry sections whose group is "start" (now including "sandbox-failures")', () => {
    expect(HUB_SECTION_IDS).toEqual(reg.filter((s) => s.group === "start").map((s) => s.id))
    expect(HUB_SECTION_IDS).toContain("sandbox-failures")
  })
  it("every DOC_PAGES id exists in the registry; slugs are unique and match /^[a-z-]+$/", () => {
    const ids = new Set(reg.map((s) => s.id))
    for (const p of DOC_PAGES) for (const id of p.sectionIds) expect(ids.has(id)).toBe(true)
    const slugs = DOC_PAGES.map((p) => p.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const s of slugs) expect(s).toMatch(/^[a-z-]+$/)
  })
  it("sectionsForPage bills is the five bills ids in registry order; null is the hub", () => {
    expect(sectionsForPage(reg, "bills").map((s) => s.id)).toEqual([
      "bill-payment-flow",
      "utility-billers",
      "utility-lookup",
      "utility-pay",
      "utility-orders",
    ])
    expect(sectionsForPage(reg, null).map((s) => s.id)).toEqual(reg.filter((s) => s.group === "start").map((s) => s.id))
  })
  it("docPath builds hub and page paths", () => {
    expect(docPath()).toBe("/developers")
    expect(docPath("data")).toBe("/developers/data")
  })
  it("sectionHref and endpointHref", () => {
    expect(sectionHref("utility-pay")).toBe("/developers/bills#utility-pay")
    expect(endpointHref(reg, "data-purchase")).toBe("/developers/data#endpoint-data-purchase")
  })
  it("pageSlugForSection: unknown is undefined, hub is null", () => {
    expect(pageSlugForSection("nope")).toBeUndefined()
    expect(pageSlugForSection("overview")).toBeNull()
  })
  it("every DOC_PAGES description is 120..160 characters", () => {
    for (const p of DOC_PAGES) {
      expect(p.description.length, p.slug).toBeGreaterThanOrEqual(120)
      expect(p.description.length, p.slug).toBeLessThanOrEqual(160)
    }
  })
})

describe("error keys", () => {
  it("errorCode extracts the token", () => {
    expect(errorCode("INSUFFICIENT_BALANCE: wallet balance is too low; required 4.50")).toBe("INSUFFICIENT_BALANCE")
  })
  it("errorCode strips an orders[i] prefix and returns null without a code", () => {
    expect(errorCode("orders[i]: REFERENCE_REUSED: reference already used")).toBe("REFERENCE_REUSED")
    expect(errorCode("Invalid or missing API key")).toBeNull()
  })
  it("errorAnchor builds lowercase keys with a capped slug", () => {
    expect(errorAnchor(401, "Invalid or missing API key")).toBe("401-invalid-or-missing-api-key")
    expect(errorAnchor(409, "REFERENCE_REUSED: x")).toBe("409-reference_reused")
    const long = errorAnchor(400, "word ".repeat(40))
    expect(long.length - "400-".length).toBeLessThanOrEqual(60)
    expect(long.endsWith("-")).toBe(false)
  })
})
