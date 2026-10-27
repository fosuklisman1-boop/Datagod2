import { describe, it, expect } from "vitest"
import { buildProductJsonLd, offerPrice } from "./json-ld"
import { buildProductMetadata, availableEntries, liveBillerEntries, pageAvailability } from "./page-meta"
import { getProduct, PRODUCTS, type ProductKey } from "./products"
import { buildLiveFacts, FAILED_RAW, type ProductFacts } from "./live-facts"
import { resolveBillsConfig } from "@/lib/bills/config"

const facts = (fromPrice: number | null, parts: string[] = []): ProductFacts => ({ available: true, fromPrice, parts })

type Node = Record<string, any>
const byType = (nodes: object[], type: string): Node => {
  const n = (nodes as Node[]).find((x) => x["@type"] === type)
  if (!n) throw new Error(`no ${type} node`)
  return n
}

describe("buildProductJsonLd", () => {
  const mtn = getProduct("mtn-data")

  it("adds a GHS Offer with a 2-decimal price when fromPrice is known", () => {
    const service = byType(buildProductJsonLd(mtn, facts(3.5)), "Service")
    expect(service.offers.price).toBe("3.50")
    expect(service.offers.priceCurrency).toBe("GHS")
    expect(service.offers.availability).toBe("https://schema.org/InStock")
  })

  it("keeps sub-cedi prices to 3 decimals", () => {
    const service = byType(buildProductJsonLd(getProduct("bulk-sms"), facts(0.025)), "Service")
    expect(service.offers.price).toBe("0.025")
  })

  it("has no offers key when fromPrice is null", () => {
    const service = byType(buildProductJsonLd(mtn, facts(null)), "Service")
    expect("offers" in service).toBe(false)
  })

  it("names DATAGOD as provider and Ghana as the area served", () => {
    const service = byType(buildProductJsonLd(mtn, facts(1)), "Service")
    expect(service.provider).toMatchObject({ "@type": "Organization", name: "DATAGOD" })
    expect(service.areaServed).toMatchObject({ "@type": "Country", name: "Ghana" })
    expect(service.url).toBe("https://www.datagod.store/mtn-data")
  })

  it("never emits ratings or reviews for any product", () => {
    for (const p of PRODUCTS) {
      const s = JSON.stringify(buildProductJsonLd(p, facts(2)))
      expect(s).not.toContain("AggregateRating")
      expect(s).not.toContain('"review"')
      expect(s).not.toContain('"Review"')
      expect(s).not.toContain("aggregateRating")
    }
  })

  it("has one FAQPage question per registry FAQ", () => {
    for (const p of PRODUCTS) {
      const faq = byType(buildProductJsonLd(p, facts(null)), "FAQPage")
      expect(faq.mainEntity).toHaveLength(p.faqs.length)
      expect(faq.mainEntity[0]).toMatchObject({
        "@type": "Question",
        name: p.faqs[0].question,
        acceptedAnswer: { "@type": "Answer", text: p.faqs[0].answer },
      })
    }
  })

  it("builds a breadcrumb with absolute URLs and numeric positions ending at the product", () => {
    const crumbs = byType(buildProductJsonLd(mtn, facts(null)), "BreadcrumbList").itemListElement as Node[]
    expect(crumbs.length).toBeGreaterThanOrEqual(2)
    for (const [i, c] of crumbs.entries()) {
      expect(c.position).toBe(i + 1)
      expect(c.item).toMatch(/^https:\/\/www\.datagod\.store/)
    }
    expect(crumbs[0].item).toBe("https://www.datagod.store")
    expect(crumbs.at(-1)).toMatchObject({ name: mtn.name, item: "https://www.datagod.store/mtn-data" })
  })

  it("returns Service, FAQPage and BreadcrumbList in that order, each with a context", () => {
    const nodes = buildProductJsonLd(mtn, facts(null)) as Node[]
    expect(nodes.map((n) => n["@type"])).toEqual(["Service", "FAQPage", "BreadcrumbList"])
    for (const n of nodes) expect(n["@context"]).toBe("https://schema.org")
  })
})

describe("offerPrice", () => {
  it("uses 2 decimals from 1 cedi and 3 below", () => {
    expect(offerPrice(3.5)).toBe("3.50")
    expect(offerPrice(12)).toBe("12.00")
    expect(offerPrice(0.025)).toBe("0.025")
    expect(offerPrice(0.5)).toBe("0.500")
  })
})

describe("buildProductMetadata", () => {
  it("uses the registry title/description and an absolute canonical", () => {
    const p = getProduct("mtn-data")
    const m = buildProductMetadata(p)
    expect(m.alternates?.canonical).toBe("https://www.datagod.store/mtn-data")
    expect(m.title).toBe(p.title)
    expect(m.description).toBe(p.description)
  })

  it("sets Open Graph url/title/description/image", () => {
    const p = getProduct("airtime")
    const og = buildProductMetadata(p).openGraph as Record<string, unknown>
    expect(og.url).toBe("https://www.datagod.store/airtime")
    expect(og.title).toBe(p.title)
    expect(og.description).toBe(p.description)
    expect(og.images).toEqual(["/og-image.png"])
  })

  it("sets its own Twitter card so the root's 'Instant ...' copy is not inherited", () => {
    const p = getProduct("airtime")
    const tw = buildProductMetadata(p).twitter as Record<string, unknown>
    expect(tw.card).toBe("summary_large_image")
    expect(tw.title).toBe(p.title)
    expect(tw.description).toBe(p.description)
    expect(String(tw.title) + String(tw.description)).not.toMatch(/Instant/)
    expect(tw.images).toEqual(["/og-image.png"])
  })
})

describe("page helpers", () => {
  const allOn = () => {
    const f = buildLiveFacts({
      ...FAILED_RAW,
      packages: [{ network: "MTN", price: 4, is_available: true }],
      bills: resolveBillsConfig({
        enabled: true,
        billers: {
          ecg: { enabled: true, min: 5, max: 100 },
          ghana_water: { enabled: false },
          dstv: { enabled: true, min: 5, max: 100 },
          gotv: { enabled: false },
          startimes: { enabled: false },
          telecel_broadband: { enabled: false },
        },
      }),
    })
    return f
  }

  it("availableEntries keeps only available products, in the given order", () => {
    const f = allOn()
    const keys: ProductKey[] = ["telecel-data", "mtn-data", "join", "developers"]
    expect(availableEntries(keys, f).map((p) => p.key)).toEqual(["mtn-data", "join"])
  })

  it("liveBillerEntries returns the biller pages that are switched on", () => {
    const f = allOn()
    expect(liveBillerEntries(f).map((p) => p.key)).toEqual(["ecg-prepaid", "pay-dstv"])
  })

  it("liveBillerEntries is empty when bills are off", () => {
    expect(liveBillerEntries(buildLiveFacts(FAILED_RAW))).toEqual([])
  })
})

describe("pageAvailability", () => {
  it("is missing for a dark product (fail-closed facts)", () => {
    const facts = buildLiveFacts(FAILED_RAW)
    expect(pageAvailability("ussd", facts)).toBe("missing")
    expect(pageAvailability("pay-dstv", facts)).toBe("missing")
  })
  it("is ok when the product is available", () => {
    const facts = buildLiveFacts(FAILED_RAW)
    facts.products.ussd = { ...facts.products.ussd, available: true }
    expect(pageAvailability("ussd", facts)).toBe("ok")
  })
})
