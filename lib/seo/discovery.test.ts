import { describe, it, expect } from "vitest"
import { buildSitemapEntries, buildLlmsTxt } from "./discovery"
import { buildLiveFacts, FAILED_RAW, type LiveFacts, type RawFacts } from "./live-facts"
import { REFUND_LINE, SPEED_LINE } from "./products"

const NOW = new Date("2026-10-27T00:00:00Z")

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
    const urls = buildSitemapEntries(facts(), NOW).map((e) => e.url)
    expect(urls.some((u) => u.includes("/shop/"))).toBe(false)
    expect(urls.every((u) => u === "https://www.datagod.store" || u.startsWith("https://www.datagod.store/"))).toBe(true)
  })

  it("omits utility bills and billers when bills are off", () => {
    const urls = buildSitemapEntries(facts(), NOW).map((e) => e.url)
    for (const p of ["/utility-bills", "/ecg-prepaid", "/ghana-water", "/pay-dstv", "/pay-gotv", "/startimes", "/telecel-broadband"]) {
      expect(urls).not.toContain(`https://www.datagod.store${p}`)
    }
  })

  it("has unique URLs and includes /services, home and legal pages", () => {
    const entries = buildSitemapEntries(facts(), NOW)
    const urls = entries.map((e) => e.url)
    expect(new Set(urls).size).toBe(urls.length)
    expect(urls).toContain("https://www.datagod.store/services")
    expect(urls).toContain("https://www.datagod.store")
    expect(urls).toContain("https://www.datagod.store/terms")
    expect(urls).toContain("https://www.datagod.store/privacy")
    expect(entries[0]).toMatchObject({ priority: 1, changeFrequency: "daily" })
  })

  it("gates /developers on availability", () => {
    const off = buildSitemapEntries(facts(), NOW).map((e) => e.url)
    const on = buildSitemapEntries(facts({ apiV2Enabled: true }), NOW).map((e) => e.url)
    expect(off).not.toContain("https://www.datagod.store/developers")
    expect(on).toContain("https://www.datagod.store/developers")
  })

  it("uses now as lastModified", () => {
    for (const e of buildSitemapEntries(facts(), NOW)) expect(e.lastModified).toBe(NOW)
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
