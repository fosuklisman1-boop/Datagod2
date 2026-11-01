import { describe, it, expect } from "vitest"
import { buildSitemapEntries, buildLlmsTxt, STATIC_PAGE_UPDATED } from "./discovery"
import { buildLiveFacts, FAILED_RAW, type LiveFacts, type RawFacts } from "./live-facts"
import { getProduct, REFUND_LINE, SPEED_LINE } from "./products"
import { getLanding } from "./landing-pages"

function facts(over: Partial<RawFacts> = {}): LiveFacts {
  return buildLiveFacts({
    ...FAILED_RAW,
    packages: [
      { network: "MTN", price: 3.5, is_available: true },
      { network: "Telecel", price: 5, is_available: true },
      { network: "AT-iShare", price: 4, is_available: true },
    ],
    airtimeEnabled: { MTN: true, Telecel: true, AT: true },
    airtimeMin: 1,
    ...over,
  })
}

describe("buildSitemapEntries", () => {
  it("has no shop URLs and only the www host", () => {
    const urls = buildSitemapEntries(facts()).map((e) => e.url)
    expect(urls.some((u) => u.includes("/shop/"))).toBe(false)
    expect(urls.every((u) => u === "https://www.datagod.store" || u.startsWith("https://www.datagod.store/"))).toBe(true)
  })

  it("omits utility bills and billers when bills are off", () => {
    const urls = buildSitemapEntries(facts()).map((e) => e.url)
    for (const p of ["/utility-bills", "/ecg-prepaid", "/ghana-water", "/pay-dstv", "/pay-gotv", "/startimes", "/telecel-broadband"]) {
      expect(urls).not.toContain(`https://www.datagod.store${p}`)
    }
  })

  it("has unique URLs and includes /services, home and legal pages", () => {
    const entries = buildSitemapEntries(facts())
    const urls = entries.map((e) => e.url)
    expect(new Set(urls).size).toBe(urls.length)
    expect(urls).toContain("https://www.datagod.store/services")
    expect(urls).toContain("https://www.datagod.store")
    expect(urls).toContain("https://www.datagod.store/terms")
    expect(urls).toContain("https://www.datagod.store/privacy")
    expect(entries[0]).toMatchObject({ priority: 1, changeFrequency: "daily" })
  })

  it("leaves out the client-only /vouchers lookup and keeps the server-rendered /ai page", () => {
    const urls = buildSitemapEntries(facts()).map((e) => e.url)
    expect(urls).not.toContain("https://www.datagod.store/vouchers")
    expect(urls).toContain("https://www.datagod.store/ai")
  })

  it("gates /developers on availability", () => {
    const off = buildSitemapEntries(facts()).map((e) => e.url)
    const on = buildSitemapEntries(facts({ apiV2Enabled: true })).map((e) => e.url)
    expect(off).not.toContain("https://www.datagod.store/developers")
    expect(on).toContain("https://www.datagod.store/developers")
  })

  it("uses stable content dates as lastModified, never the current time", () => {
    const a = buildSitemapEntries(facts())
    for (const e of a) expect(e.lastModified, e.url).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // same input, same output: lastmod only changes when someone bumps a date
    expect(buildSitemapEntries(facts())).toEqual(a)
  })

  it("takes a product's lastModified from its registry entry", () => {
    const byUrl = new Map(buildSitemapEntries(facts()).map((e) => [e.url, e.lastModified]))
    for (const key of ["mtn-data", "airtime"] as const) {
      const p = getProduct(key)
      expect(byUrl.get(`https://www.datagod.store${p.path}`)).toBe(p.updated)
    }
    expect(byUrl.get("https://www.datagod.store")).toBe(STATIC_PAGE_UPDATED["/"])
  })
})

describe("landing pages in the sitemap and llms.txt", () => {
  const withRows = () =>
    facts({
      packages: [
        { network: "MTN", size: "1", price: 3.5, is_available: true },
        { network: "AT - BigTime", size: "20", price: 60, is_available: true },
      ],
    })

  it("lists live landing pages with their registry lastmod and leaves off / failed ones out", () => {
    const byUrl = new Map(buildSitemapEntries(withRows()).map((e) => [e.url, e]))
    const prices = getLanding("data-bundle-prices")
    expect(byUrl.get("https://www.datagod.store/data-bundle-prices")).toMatchObject({ lastModified: prices.updated, priority: prices.priority })
    expect(byUrl.has("https://www.datagod.store/at-bigtime-data")).toBe(true)
    expect(byUrl.has("https://www.datagod.store/non-expiry-data-bundles")).toBe(true)
    expect(byUrl.has("https://www.datagod.store/become-a-data-reseller")).toBe(true)
    // no iShare rows -> off -> not in the sitemap
    expect(byUrl.has("https://www.datagod.store/at-ishare-data")).toBe(false)

    const failed = buildSitemapEntries(buildLiveFacts(FAILED_RAW, ["packages"])).map((e) => e.url)
    for (const path of ["/data-bundle-prices", "/non-expiry-data-bundles", "/at-ishare-data", "/at-bigtime-data"]) {
      expect(failed).not.toContain(`https://www.datagod.store${path}`)
    }
    expect(failed).toContain("https://www.datagod.store/become-a-data-reseller")
  })

  it("adds a guides section to llms.txt with the live landing pages only", () => {
    const t = buildLlmsTxt(withRows())
    expect(t).toContain("## Guides and price lists")
    expect(t).toContain("[Data Bundle Prices](https://www.datagod.store/data-bundle-prices): ")
    expect(t).toContain("(https://www.datagod.store/at-bigtime-data)")
    expect(t).not.toContain("/at-ishare-data")
    expect(t).not.toContain("..")
  })
})

describe("buildLlmsTxt", () => {
  it("has the title, verbatim trust lines and a priced MTN line", () => {
    const t = buildLlmsTxt(facts())
    expect(t.startsWith("# DATAGOD\n")).toBe(true)
    expect(t).toContain(REFUND_LINE)
    expect(t).toContain(SPEED_LINE)
    expect(t).toContain("From GH₵3.50")
    expect(t).toContain("[MTN Data Bundles](https://www.datagod.store/mtn-data)")
    expect(t).not.toContain("..")
    expect(t.endsWith("\n")).toBe(true)
    expect(t.endsWith("\n\n")).toBe(false)
  })

  it("omits USSD when there is no main code and shows it when set", () => {
    expect(buildLlmsTxt(facts())).not.toMatch(/USSD/)
    const t = buildLlmsTxt(facts({ ussd: { main: "*920#", shop: "*426*203#" } }))
    expect(t).toContain("*920#")
    expect(t).toContain("dial *426*203# and enter the seller's 4-digit shop code when asked")
  })

  it("explains the 4-digit shop code without a dial code when none is set", () => {
    const t = buildLlmsTxt(facts({ ussd: { main: "*920#", shop: null } }))
    expect(t).toContain("4-digit shop code")
    expect(t).not.toMatch(/SHOPCODE|in the format/)
  })

  it("omits developers unless available", () => {
    expect(buildLlmsTxt(facts())).not.toContain("## For developers")
    expect(buildLlmsTxt(facts())).not.toContain("/developers")
    expect(buildLlmsTxt(facts({ apiV2Enabled: true }))).toContain("## For developers")
  })

  it("never says instant", () => {
    expect(buildLlmsTxt(facts({ apiV2Enabled: true, ussd: { main: "*920#", shop: null } })).toLowerCase()).not.toContain("instant")
  })
})
