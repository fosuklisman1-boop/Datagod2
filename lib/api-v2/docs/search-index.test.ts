import { describe, it, expect } from "vitest"
import { v2DocsRegistry as reg } from "./registry"
import { DOC_PAGES, STATIC_DOC_PAGES, endpointHref } from "./pages"
import { errorAnchor } from "./error-key"
import { buildSearchIndex, searchDocs, shouldHijackSlash } from "./search-index"

const index = buildSearchIndex(reg)
const endpoints = reg.flatMap((s) => s.endpoints)

describe("buildSearchIndex", () => {
  it("has one endpoint entry per registry endpoint, titled like POST /data/purchase, href = endpointHref", () => {
    const entries = index.filter((e) => e.kind === "endpoint")
    expect(entries).toHaveLength(endpoints.length)
    expect(endpoints.length).toBe(30)
    const dp = entries.find((e) => e.title === "POST /data/purchase")!
    expect(dp.href).toBe(endpointHref(reg, "data-purchase"))
  })
  it("has section, page and error entries", () => {
    expect(index.filter((e) => e.kind === "section")).toHaveLength(reg.length)
    expect(index.filter((e) => e.kind === "page")).toHaveLength(DOC_PAGES.length + STATIC_DOC_PAGES.length)
    const keys = new Set(endpoints.flatMap((e) => e.errors.map((x) => errorAnchor(x.status, x.message))))
    const errs = index.filter((e) => e.kind === "error")
    expect(errs).toHaveLength(keys.size)
    for (const e of errs) expect(e.href.startsWith("/developers/errors#")).toBe(true)
    expect(new Set(errs.map((e) => e.href.split("#")[1]))).toEqual(keys)
  })
})

describe("searchDocs", () => {
  it('"data/purchase" returns the POST /data/purchase endpoint first', () => {
    expect(searchDocs(index, "data/purchase")[0].title).toBe("POST /data/purchase")
  })
  it('"purchase" ranks endpoint titles above error entries', () => {
    const r = searchDocs(index, "purchase", 50)
    const lastEndpoint = r.map((e) => e.kind).lastIndexOf("endpoint")
    const firstError = r.map((e) => e.kind).indexOf("error")
    expect(lastEndpoint).toBeGreaterThanOrEqual(0)
    if (firstError >= 0) expect(lastEndpoint).toBeLessThan(firstError)
  })
  it('"REFERENCE_REUSED" returns the 409 error entry; "insufficient" finds INSUFFICIENT_BALANCE', () => {
    const r = searchDocs(index, "REFERENCE_REUSED")
    expect(r.some((e) => e.kind === "error" && e.href.includes("409-reference_reused"))).toBe(true)
    expect(searchDocs(index, "  Insufficient ").some((e) => e.kind === "error" && /INSUFFICIENT_BALANCE/.test(e.keywords))).toBe(true)
  })
  it("empty queries return []; a 200 character query does not throw; limit is honoured", () => {
    expect(searchDocs(index, "")).toEqual([])
    expect(searchDocs(index, "   ")).toEqual([])
    expect(() => searchDocs(index, "a".repeat(200))).not.toThrow()
    expect(searchDocs(index, "a", 3).length).toBeLessThanOrEqual(3)
    expect(searchDocs(index, "a").length).toBeLessThanOrEqual(12)
  })
})

describe("shouldHijackSlash", () => {
  const base = { key: "/", ctrlKey: false, metaKey: false, altKey: false, target: { tagName: "BODY" } }
  it("true on body, false in form fields, contenteditable, with modifiers or other keys", () => {
    expect(shouldHijackSlash(base)).toBe(true)
    expect(shouldHijackSlash({ ...base, target: null })).toBe(true)
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) expect(shouldHijackSlash({ ...base, target: { tagName } })).toBe(false)
    expect(shouldHijackSlash({ ...base, target: { tagName: "DIV", isContentEditable: true } })).toBe(false)
    expect(shouldHijackSlash({ ...base, ctrlKey: true })).toBe(false)
    expect(shouldHijackSlash({ ...base, metaKey: true })).toBe(false)
    expect(shouldHijackSlash({ ...base, altKey: true })).toBe(false)
    expect(shouldHijackSlash({ ...base, key: "a" })).toBe(false)
  })
})
