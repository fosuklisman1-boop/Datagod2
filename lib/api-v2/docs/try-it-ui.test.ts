import { createElement } from "react"
import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { TryIt } from "@/components/developer/docs/TryIt"
import { EndpointBlock } from "@/components/developer/docs/EndpointBlock"
import { v2DocsRegistry } from "./registry"

const ep = v2DocsRegistry.flatMap((s) => s.endpoints).find((e) => e.id === "data-purchase")!
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")

describe("TryIt ui", () => {
  const html = renderToStaticMarkup(createElement(TryIt, { endpoint: ep }))
  it("has password key field, prefilled textarea and Send", () => {
    const input = html.match(/<input[^>]*type="password"[^>]*>/)?.[0] ?? ""
    expect(input).toMatch(/autoComplete="off"|autocomplete="off"/i)
    expect(input).toContain('value=""')
    expect(decode(html)).toContain(JSON.stringify(ep.requestExample, null, 2))
    expect(html).toMatch(/<textarea/)
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Send/)
  })
  it("states test keys only and links go-live", () => {
    expect(html.toLowerCase()).toContain("test keys only")
    expect(html).toContain('href="/developers/go-live"')
  })
  it("sources never touch browser storage", () => {
    for (const f of ["components/developer/docs/TryIt.tsx", "lib/api-v2/docs/try-it.ts"]) {
      const src = readFileSync(f, "utf8")
      for (const w of ["localStorage", "sessionStorage", "document.cookie", "location.search", "history.replaceState", "indexedDB"]) {
        expect(src, `${f} ${w}`).not.toContain(w)
      }
    }
  })
})

describe("EndpointBlock tryIt slot", () => {
  it("unchanged without tryIt", () => {
    const h = renderToStaticMarkup(createElement(EndpointBlock, { endpoint: ep }))
    expect(h).not.toContain("Try it")
    expect(h).not.toContain("xl:grid-cols-2")
  })
  it("split layout with tryIt", () => {
    const h = renderToStaticMarkup(createElement(EndpointBlock, { endpoint: ep, layout: "split", tryIt: createElement("div", null, "Try it here") }))
    expect(h).toContain("xl:grid-cols-2")
    expect(h).toContain("Try it here")
  })
})
