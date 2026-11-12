import { describe, expect, it } from "vitest"
import { homeDataNetworkLinks, homeFooterLinks, homePopularPackages, homeServiceLinks } from "./home-links"
import { buildLiveFacts, FAILED_RAW, FALLBACK_FACTS, type LiveFacts } from "./live-facts"
import type { ProductKey } from "./products"

function factsWith(on: ProductKey[]): LiveFacts {
  const products = { ...FALLBACK_FACTS.products }
  for (const k of Object.keys(products) as ProductKey[]) {
    products[k] = { ...products[k], available: on.includes(k) }
  }
  return { ...FALLBACK_FACTS, products }
}

const ZERO_ADJ = { price_adjustment_mtn: 0, price_adjustment_telecel: 0, price_adjustment_at_ishare: 0, price_adjustment_at_bigtime: 0 }

const ALL_ON: ProductKey[] = [
  "mtn-data", "telecel-data", "at-data", "cheapest-data", "airtime", "afa-registration", "utility-bills",
  "results-checker", "bulk-sms", "join", "ussd", "whatsapp", "developers",
]

describe("homeServiceLinks", () => {
  it("links every card on the main site when everything is live", () => {
    expect(homeServiceLinks(factsWith(ALL_ON), true)).toEqual({
      airtime: "/airtime",
      afa: "/afa-registration",
      bills: "/utility-bills",
      results: "/results-checker",
      "results-service": "/results-checker",
      "bulk-sms": "/bulk-sms",
      shops: "/join",
      "sub-agents": "/join",
      developers: "/developers",
      anywhere: "/ussd",
      all: "/services",
    })
  })

  it("links nothing on a custom domain or shop host", () => {
    expect(homeServiceLinks(factsWith(ALL_ON), false)).toEqual({})
  })

  it("drops links to products that are switched off", () => {
    const links = homeServiceLinks(factsWith(["mtn-data", "results-checker", "bulk-sms", "join"]), true)
    expect(links.airtime).toBeUndefined()
    expect(links.afa).toBeUndefined()
    expect(links.bills).toBeUndefined()
    expect(links.developers).toBeUndefined()
    expect(links.anywhere).toBeUndefined()
    expect(links.data).toBeUndefined()
    expect(links.results).toBe("/results-checker")
    expect(links.all).toBe("/services")
  })

})

describe("homeDataNetworkLinks", () => {
  it("links each live network page, in network order", () => {
    expect(homeDataNetworkLinks(factsWith(ALL_ON), true)).toEqual([
      { label: "MTN", href: "/mtn-data" },
      { label: "Telecel", href: "/telecel-data" },
      { label: "AT", href: "/at-data" },
    ])
  })
  it("leaves out networks that are off, and everything off the main site", () => {
    expect(homeDataNetworkLinks(factsWith(["at-data"]), true)).toEqual([{ label: "AT", href: "/at-data" }])
    expect(homeDataNetworkLinks(factsWith(ALL_ON), false)).toEqual([])
  })
})

describe("homeFooterLinks", () => {
  it("links every live product page, then the live landing pages, then the guides hub", () => {
    // factsWith() has no price rows (packages read failed), so only the reseller guide is live.
    expect(homeFooterLinks(factsWith(ALL_ON), true)).toEqual([
      { label: "MTN data", href: "/mtn-data" },
      { label: "Telecel data", href: "/telecel-data" },
      { label: "AT data", href: "/at-data" },
      { label: "Cheapest data in Ghana", href: "/cheapest-data-ghana" },
      { label: "Airtime", href: "/airtime" },
      { label: "Utility bills", href: "/utility-bills" },
      { label: "Results checker", href: "/results-checker" },
      { label: "MTN AFA registration", href: "/afa-registration" },
      { label: "Open a reseller shop", href: "/join" },
      { label: "Become a data reseller", href: "/become-a-data-reseller" },
      { label: "Guides", href: "/guides" },
    ])
  })
  it("leaves the guides hub out when no guide is published", () => {
    expect(homeFooterLinks(factsWith(["mtn-data"]), true, []).map((l) => l.href)).toEqual(["/mtn-data"])
  })
  it("links the price-list landing pages while their rows are on sale", () => {
    const f = buildLiveFacts({
      ...FAILED_RAW,
      priceAdjustments: ZERO_ADJ,
      packages: [
        { network: "MTN", size: "1", price: 5, is_available: true },
        { network: "Telecel", size: "5", price: 20, is_available: true, description: "No expiry" },
        { network: "AT - iShare", size: "1", price: 4, is_available: true },
      ],
    })
    const landing = homeFooterLinks(f, true, []).filter((l) => !["/mtn-data", "/telecel-data", "/at-data", "/cheapest-data-ghana", "/join"].includes(l.href))
    expect(landing).toEqual([
      { label: "Non-expiry data", href: "/non-expiry-data-bundles" },
      { label: "Become a data reseller", href: "/become-a-data-reseller" },
      { label: "AT iShare data", href: "/at-ishare-data" },
    ])
  })
  it("never links a switched-off product, and nothing off the main site", () => {
    const hrefs = homeFooterLinks(factsWith(["mtn-data", "join"]), true, []).map((l) => l.href)
    expect(hrefs).toEqual(["/mtn-data", "/join", "/become-a-data-reseller"])
    expect(homeFooterLinks(factsWith(["mtn-data"]), true, []).map((l) => l.href)).toEqual(["/mtn-data"])
    expect(homeFooterLinks(factsWith(ALL_ON), false)).toEqual([])
  })
})

describe("homePopularPackages", () => {
  const facts = buildLiveFacts({
    ...FAILED_RAW,
    priceAdjustments: { ...ZERO_ADJ, price_adjustment_mtn: 10 },
    packages: [
      { network: "MTN", size: "2", price: 10, is_available: true },
      { network: "MTN", size: "1", price: 5, is_available: true },
      { network: "AT - iShare", size: "1", price: 4.5, is_available: true },
      { network: "Telecel", size: "1", price: 6, is_available: false },
    ],
  })

  it("is the cheapest adjusted row per network / AT type, linked to its network page", () => {
    expect(homePopularPackages(facts, true)).toEqual([
      { network: "MTN", size: "1GB", price: 5.5, href: "/mtn-data" },
      { network: "AT iShare", size: "1GB", price: 4.5, href: "/at-data" },
    ])
  })
  it("is unlinked off the main site", () => {
    expect(homePopularPackages(facts, false).every((p) => p.href === undefined)).toBe(true)
  })
  it("is empty when the prices could not be read", () => {
    expect(homePopularPackages(FALLBACK_FACTS, true)).toEqual([])
  })
})
