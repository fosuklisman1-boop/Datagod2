import { describe, it, expect } from "vitest"
import { buildDocsNav, activeNavHref } from "./nav"

describe("Status entry (Release 4)", () => {
  it("Reference lists API status once", () => {
    const ref = buildDocsNav().find((g) => g.label === "Reference")!.items
    expect(ref.filter((i) => i.href === "/developers/status")).toEqual([{ label: "API status", href: "/developers/status" }])
  })
})
import { DOC_PAGES, STATIC_DOC_PAGES, sectionHref, sectionsForPage } from "./pages"
import { v2DocsRegistry } from "./registry"

describe("buildDocsNav", () => {
  const nav = buildDocsNav()
  const group = (label: string) => nav.find((g) => g.label === label)!

  it("has exactly Start, Products, Reference in that order", () => {
    expect(nav.map((g) => g.label)).toEqual(["Start", "Products", "Reference"])
  })

  it("Products lists the 7 pages with their sections", () => {
    const items = group("Products").items
    expect(items).toHaveLength(7)
    expect(items.map((i) => i.href)).toEqual(DOC_PAGES.map((p) => `/developers/${p.slug}`))
    for (const page of DOC_PAGES) {
      const item = items.find((i) => i.href === `/developers/${page.slug}`)!
      const expected = sectionsForPage(v2DocsRegistry, page.slug).map((s) => ({ id: s.id, label: s.label, href: sectionHref(s.id) }))
      expect(item.sections).toEqual(expected)
      expect(expected.length).toBeGreaterThan(0)
    }
  })

  it("lists every static page exactly once, plus OpenAPI and Postman under Reference", () => {
    const hrefs = nav.flatMap((g) => g.items.map((i) => i.href))
    for (const p of STATIC_DOC_PAGES) expect(hrefs.filter((h) => h === `/developers/${p.slug}`)).toHaveLength(1)
    const ref = group("Reference").items.map((i) => i.href)
    expect(ref).toContain("/developers/openapi.json")
    expect(ref).toContain("/developers/postman/collection")
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it("Start begins with the Overview hub", () => {
    expect(group("Start").items[0].href).toBe("/developers")
  })
})

describe("activeNavHref", () => {
  it("matches the exact page and ignores hash, query and trailing slash", () => {
    expect(activeNavHref("/developers")).toBe("/developers")
    expect(activeNavHref("/developers/data")).toBe("/developers/data")
    expect(activeNavHref("/developers/data/")).toBe("/developers/data")
    expect(activeNavHref("/developers/data#packages")).toBe("/developers/data")
    expect(activeNavHref("/developers/data?x=1")).toBe("/developers/data")
  })
})
