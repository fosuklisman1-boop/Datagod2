import { describe, it, expect } from "vitest"
import { GUIDES, getPublishedGuide, publishedGuides, type Guide } from "./guides"
import { BANNED_COPY, metaProblems } from "./copy-rules"
import { PRODUCTS } from "./products"

function allText(g: Guide): string {
  return [
    g.title,
    g.description,
    g.h1,
    ...g.sections.flatMap((s) => [s.heading, ...s.paragraphs, ...(s.steps ?? [])]),
    ...g.faqs.flatMap((f) => [f.question, f.answer]),
  ].join("\n")
}

describe("guides", () => {
  it("has unique slugs and a YYYY-MM-DD updated date", () => {
    const slugs = GUIDES.map((g) => g.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const g of GUIDES) expect(g.updated, g.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("obeys the shared copy rules", () => {
    for (const g of GUIDES) {
      expect(metaProblems(g.title, g.description), g.slug).toEqual([])
      expect(allText(g), g.slug).not.toMatch(BANNED_COPY)
      expect(allText(g), g.slug).not.toMatch(/ishare|bigtime/i)
    }
  })

  it("only relates to real products", () => {
    const keys = new Set(PRODUCTS.map((p) => p.key))
    for (const g of GUIDES) for (const r of g.related) expect(keys.has(r), `${g.slug} -> ${r}`).toBe(true)
  })

  it("publishes buy-data-with-momo and keeps check-data-balance unpublished", () => {
    expect(getPublishedGuide("buy-data-with-momo")?.slug).toBe("buy-data-with-momo")
    expect(GUIDES.find((g) => g.slug === "check-data-balance")?.published).toBe(false)
    expect(getPublishedGuide("check-data-balance")).toBeNull()
    expect(getPublishedGuide("nope")).toBeNull()
    expect(publishedGuides().map((g) => g.slug)).toEqual(["buy-data-with-momo"])
  })

  it("never puts a USSD code in guide copy (balance codes not supplied)", () => {
    for (const g of GUIDES) expect(allText(g), g.slug).not.toMatch(/\*\d{2,4}[*#]/)
  })

  it("uses the wallet wording and the verbatim speed/refund lines in the buy guide", () => {
    const g = getPublishedGuide("buy-data-with-momo")!
    const t = allText(g)
    expect(t).toContain("fund your wallet with MoMo or card")
    expect(t).toContain("Usually delivered within minutes.")
    expect(t).toContain("If an order fails, you get your money back.")
  })
})
