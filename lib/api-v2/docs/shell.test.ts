import { createElement } from "react"
import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { DocsSidebar } from "@/components/developer/docs/DocsSidebar"
import { DocsPage } from "@/components/developer/docs/DocsPage"
import DevelopersLayout from "@/app/developers/layout"
import { buildDocsNav } from "./nav"
import { DOC_PAGES, sectionsForPage } from "./pages"
import { v2DocsRegistry } from "./registry"

const STYLE = "body{overflow-x:visible !important}"

describe("docs shell", () => {
  const html = renderToStaticMarkup(createElement(DocsSidebar, { nav: buildDocsNav() }))

  it("sidebar links all 7 product pages inside a hidden lg:block wrapper", () => {
    for (const p of DOC_PAGES) expect(html).toContain(`href="/developers/${p.slug}"`)
    expect(html).toContain("hidden lg:block")
  })

  it("phone menu trigger is lg:hidden", () => {
    expect(html).toMatch(/<button[^>]*class="[^"]*lg:hidden[^"]*"[^>]*>(?:(?!<\/button>)[\s\S])*Docs menu/)
  })

  it("has no fixed pixel width above 320 outside an lg: variant", () => {
    const layout = renderToStaticMarkup(createElement(DevelopersLayout, null, createElement("div")))
    for (const markup of [html, layout]) {
      for (const m of markup.matchAll(/(?:^|[\s"])((?:[a-z0-9-]+:)*)(?:min-w|w)-\[(\d+)px\]/g)) {
        const [, variants, px] = m
        if (Number(px) > 320) expect(variants, m[0]).toContain("lg:")
      }
    }
  })

  it("DocsPage drops the SECTION bar with showSectionNav={false} and keeps it by default", () => {
    const sections = sectionsForPage(v2DocsRegistry, "data")
    const off = renderToStaticMarkup(createElement(DocsPage, { sections, compact: true, showSectionNav: false }))
    const on = renderToStaticMarkup(createElement(DocsPage, { sections, compact: true }))
    expect(off).not.toContain("Section:")
    expect(off).toContain('id="packages"')
    expect(on).toContain("Section:")
  })

  it("layout carries the scoped body overflow style exactly once", () => {
    const layout = renderToStaticMarkup(createElement(DevelopersLayout, null, createElement("p", null, "child-here")))
    expect(layout.split(STYLE).length - 1).toBe(1)
    expect(layout).toContain("child-here")
    expect(layout).toContain("lg:grid-cols-[240px_minmax(0,1fr)]")
  })
})
