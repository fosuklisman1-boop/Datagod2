import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import GroupPage, { generateStaticParams, generateMetadata, dynamicParams } from "./[group]/page"
import { DOC_PAGES } from "@/lib/api-v2/docs/pages"

describe("[group] page", () => {
  it("generates the 7 slugs and refuses others", () => {
    expect(generateStaticParams()).toEqual(DOC_PAGES.map((p) => ({ group: p.slug })))
    expect(generateStaticParams()).toHaveLength(7)
    expect(dynamicParams).toBe(false)
    expect(generateStaticParams().some((p) => (p.group as string) === "nope")).toBe(false)
  })

  it("has metadata with a canonical for each slug", async () => {
    for (const p of DOC_PAGES) {
      const m = await generateMetadata({ params: Promise.resolve({ group: p.slug }) })
      expect(m.alternates?.canonical).toBe(`https://www.datagod.store/developers/${p.slug}`)
    }
  })

  it("renders the page's sections", async () => {
    const el = await GroupPage({ params: Promise.resolve({ group: "airtime" }) })
    const html = renderToStaticMarkup(el)
    expect(html).toContain('id="airtime-purchase"')
    expect(html).not.toContain('id="wallet"')
  })
})
