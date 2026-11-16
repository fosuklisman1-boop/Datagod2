import { describe, it, expect } from "vitest"
import {
  LANDING_PAGES,
  availableLandings,
  findLandingByPath,
  getLanding,
  landingAvailability,
  landingCopyText,
  landingGroups,
  landingSections,
  landingsForProduct,
  type LandingEntry,
  type LandingKey,
  type ParagraphContext,
} from "./landing-pages"
import { PRODUCTS, REFUND_LINE, SPEED_LINE } from "./products"
import { buildLiveFacts, FAILED_RAW, FALLBACK_FACTS, type LiveFacts, type RawFacts } from "./live-facts"
import { wordCount } from "./data-page-copy"
import { buildLandingJsonLd, landingCrumbs } from "./json-ld"

type RawPackageRow = NonNullable<RawFacts["packages"]>[number]

const ZERO_ADJ = { price_adjustment_mtn: 0, price_adjustment_telecel: 0, price_adjustment_at_ishare: 0, price_adjustment_at_bigtime: 0 }

/** "network|label|price" for every row of every group, in order. */
const flat = (gs: ReturnType<typeof landingGroups>) => gs.flatMap((g) => g.rows.map((r) => `${g.network}|${r.label}|${r.price}`))

const BANNED = /instant|in seconds|automatic(ally)? refund/i

const CONTEXTS: ParagraphContext[] = [
  { rows: 0, standardNoExpiry: false },
  { rows: 0, standardNoExpiry: true },
  { rows: 3, standardNoExpiry: false },
  { rows: 3, standardNoExpiry: true },
]

/** Every string on the page that comes from the registry, all conditional paragraphs included. */
function allText(e: LandingEntry): string {
  return [
    e.name,
    e.h1,
    e.title,
    e.description,
    e.lede,
    ...(e.steps ?? []).flatMap((s) => [s.title, s.body]),
    ...e.sections.flatMap((s) => [s.heading, ...s.paragraphs.map((p) => (typeof p === "string" ? p : p.text))]),
    ...e.faqs.flatMap((f) => [f.question, f.answer]),
  ].join("\n")
}

const PACKAGES: RawPackageRow[] = [
  { network: "MTN", size: "1", price: 5, is_available: true, description: "30 days" },
  { network: "MTN", size: "2", price: 9, is_available: true },
  { network: "Telecel", size: "5", price: 20, is_available: true, description: "No expiry" },
  { network: "Telecel", size: "10", price: 38, is_available: true, description: "Non-expiry bundle" },
  { network: "AT - iShare", size: "1", price: 4, is_available: true },
  { network: "AT - BigTime", size: "20", price: 60, is_available: true },
  { network: "MTN", size: "3", price: 12, is_available: false, description: "No expiry" },
]

function facts(over: Partial<RawFacts> = {}, failed: string[] = []): LiveFacts {
  return buildLiveFacts({ ...FAILED_RAW, priceAdjustments: ZERO_ADJ, packages: PACKAGES, ...over }, failed)
}

describe("landing page registry", () => {
  it("has unique keys and paths that never clash with a product page", () => {
    const keys = LANDING_PAGES.map((e) => e.key)
    const paths = LANDING_PAGES.map((e) => e.path)
    expect(new Set(keys).size).toBe(keys.length)
    expect(new Set(paths).size).toBe(paths.length)
    for (const e of LANDING_PAGES) {
      expect(e.path).toBe(`/${e.key}`)
      expect(PRODUCTS.some((p) => p.path === e.path), e.path).toBe(false)
    }
  })

  it("keeps titles <= 60 chars ending in | DATAGOD and descriptions 120-160 chars, all unique", () => {
    const titles = new Set<string>([...PRODUCTS.map((p) => p.title)])
    const descriptions = new Set<string>([...PRODUCTS.map((p) => p.description)])
    for (const e of LANDING_PAGES) {
      expect(e.title.length, `${e.key} title: ${e.title}`).toBeLessThanOrEqual(60)
      expect(e.title.endsWith("| DATAGOD"), e.key).toBe(true)
      expect(e.description.length, `${e.key} description (${e.description.length})`).toBeGreaterThanOrEqual(120)
      expect(e.description.length, `${e.key} description (${e.description.length})`).toBeLessThanOrEqual(160)
      expect(titles.has(e.title), `${e.key} title is not unique`).toBe(false)
      expect(descriptions.has(e.description), `${e.key} description is not unique`).toBe(false)
      titles.add(e.title)
      descriptions.add(e.description)
    }
  })

  it("has 300-600 words of page copy whichever conditional paragraphs show", () => {
    for (const e of LANDING_PAGES) {
      for (const ctx of CONTEXTS) {
        const n = wordCount(landingCopyText(e, ctx))
        expect(n, `${e.key} ${JSON.stringify(ctx)}: ${n} words`).toBeGreaterThanOrEqual(300)
        expect(n, `${e.key} ${JSON.stringify(ctx)}: ${n} words`).toBeLessThanOrEqual(600)
      }
    }
  })

  it("has 4-8 FAQs including the verbatim refund and speed lines", () => {
    for (const e of LANDING_PAGES) {
      expect(e.faqs.length, e.key).toBeGreaterThanOrEqual(4)
      expect(e.faqs.length, e.key).toBeLessThanOrEqual(8)
      expect(e.faqs.some((f) => f.answer.includes(REFUND_LINE)), `${e.key} refund FAQ`).toBe(true)
      expect(e.faqs.some((f) => f.answer.includes(SPEED_LINE)), `${e.key} speed FAQ`).toBe(true)
    }
  })

  it("never uses banned speed / refund wording", () => {
    for (const e of LANDING_PAGES) expect(allText(e), e.key).not.toMatch(BANNED)
  })

  it("never states a price, amount, percentage, rating or USSD code (prices come only from the tables)", () => {
    for (const e of LANDING_PAGES) {
      const t = allText(e)
      expect(t, e.key).not.toMatch(/GH₵|GHS|cedis? ?\d|\d+(\.\d+)? ?(GB|MB)\b/i)
      expect(t, e.key).not.toMatch(/\*\d{2,4}[*#]/)
      expect(t, e.key).not.toMatch(/\bratings?\b|\brated\b|\breviews?\b|\bstars?\b|\d+ ?%|percent/i)
      // The only numbers allowed are phone prefixes (0 + 2 digits) and the 4-digit shop code.
      for (const n of t.replace(/4-digit/g, "").match(/\d+/g) ?? []) expect(n, `${e.key}: ${n}`).toMatch(/^0\d\d$/)
    }
  })

  it("never promises earnings or income", () => {
    for (const e of LANDING_PAGES) {
      expect(allText(e), e.key).not.toMatch(/guarantee|passive income|earn up to|make money fast|get rich/i)
    }
  })

  it("mentions MoMo on every page and never says web buyers pay Paystack directly", () => {
    for (const e of LANDING_PAGES) {
      expect(allText(e), e.key).toMatch(/MoMo/)
      expect(e.description, e.key).not.toMatch(/pay with momo or card/i)
      expect(e.lede, e.key).not.toMatch(/pay with momo or card/i)
    }
  })

  it("only links product keys that exist, and the network pages it lists exist", () => {
    const keys = new Set(PRODUCTS.map((p) => p.key))
    for (const e of LANDING_PAGES) {
      expect(e.relatedProducts.length, e.key).toBeGreaterThan(0)
      for (const k of e.relatedProducts) expect(keys.has(k), `${e.key} -> ${k}`).toBe(true)
      if (e.parent) expect(keys.has(e.parent), `${e.key} parent`).toBe(true)
    }
  })

  it("has a stable YYYY-MM-DD updated date and a footer label", () => {
    for (const e of LANDING_PAGES) {
      expect(e.updated, e.key).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isNaN(Date.parse(e.updated)), e.key).toBe(false)
      expect(e.footerLabel.length, e.key).toBeGreaterThan(0)
      expect(e.priority, e.key).toBeGreaterThan(0)
      expect(e.priority, e.key).toBeLessThanOrEqual(1)
    }
  })

  it("finds entries by path (trailing slash ignored) and throws on an unknown key", () => {
    for (const e of LANDING_PAGES) {
      expect(findLandingByPath(e.path)?.key).toBe(e.key)
      expect(findLandingByPath(`${e.path}/`)?.key).toBe(e.key)
      expect(getLanding(e.key)).toBe(e)
    }
    expect(findLandingByPath("/mtn-data")).toBeUndefined()
    expect(findLandingByPath(null)).toBeUndefined()
    expect(() => getLanding("nope" as LandingKey)).toThrow()
  })
})

describe("landingSections", () => {
  it("drops paragraphs whose condition does not hold, and empty sections", () => {
    const e: LandingEntry = {
      ...getLanding("non-expiry-data-bundles"),
      sections: [
        { heading: "A", paragraphs: ["always", { when: "has-rows", text: "rows" }, { when: "no-rows", text: "none" }] },
        { heading: "B", paragraphs: [{ when: "standard-no-expiry", text: "standard" }] },
      ],
    }
    expect(landingSections(e, { rows: 2, standardNoExpiry: false })).toEqual([{ heading: "A", paragraphs: ["always", "rows"] }])
    expect(landingSections(e, { rows: 0, standardNoExpiry: true })).toEqual([
      { heading: "A", paragraphs: ["always", "none"] },
      { heading: "B", paragraphs: ["standard"] },
    ])
  })
})

describe("no all-networks price page", () => {
  it("leaves cross-network prices to /cheapest-data-ghana (main's comparison page)", () => {
    expect(findLandingByPath("/data-bundle-prices")).toBeUndefined()
    expect(PRODUCTS.find((p) => p.key === "cheapest-data")?.path).toBe("/cheapest-data-ghana")
    for (const e of LANDING_PAGES.filter((x) => x.showsPrices)) expect(e.relatedProducts, e.key).toContain("cheapest-data")
  })
})

describe("landing JSON-LD", () => {
  it("is FAQ and breadcrumb from the page, with no offers of its own", () => {
    for (const e of LANDING_PAGES) {
      const nodes = buildLandingJsonLd(e, landingCrumbs(e)) as any[]
      expect(nodes.map((n) => n["@type"]), e.key).toEqual(["FAQPage", "BreadcrumbList"])
      expect(nodes[0].mainEntity.map((q: any) => q.name)).toEqual(e.faqs.map((f) => f.question))
      expect(JSON.stringify(nodes)).not.toMatch(/aggregateRating|review|Offer/i)
    }
  })
})

describe("availableLandings", () => {
  it("lists only ok pages, in registry order", () => {
    expect(availableLandings(facts()).map((e) => e.key)).toEqual(LANDING_PAGES.map((e) => e.key))
    expect(availableLandings(FALLBACK_FACTS).map((e) => e.key)).toEqual(["become-a-data-reseller"])
  })
})

describe("non-expiry-data-bundles", () => {
  const e = getLanding("non-expiry-data-bundles")

  it("shows only available rows whose description says no expiry, at the adjusted price", () => {
    expect(flat(landingGroups(e, facts()))).toEqual(["Telecel|5GB|20", "Telecel|10GB|38"])
    const adjusted = facts({ priceAdjustments: { ...ZERO_ADJ, price_adjustment_telecel: 10 } })
    expect(flat(landingGroups(e, adjusted))).toEqual(["Telecel|5GB|22", "Telecel|10GB|41.8"])
    // the unavailable MTN "No expiry" row and rows without a no-expiry description never show
    expect(landingGroups(e, facts()).some((g) => g.network === "MTN")).toBe(false)
  })

  it("stays ok (honest empty state) with no such rows, and fails only when the prices could not be read", () => {
    const none = facts({ packages: [{ network: "MTN", size: "1", price: 5, is_available: true, description: "30 days" }] })
    expect(landingGroups(e, none)).toEqual([])
    expect(landingAvailability(e, none)).toBe("ok")
    expect(landingAvailability(e, facts({ packages: [] }))).toBe("ok")
    expect(landingAvailability(e, facts({ packages: null }, ["packages"]))).toBe("failed")
    expect(landingAvailability(e, facts({ priceAdjustments: null }, ["price-adjust"]))).toBe("failed")
  })

  it("says there are none, instead of claiming bundles, when there are no rows", () => {
    const empty = landingSections(e, { rows: 0, standardNoExpiry: false }).flatMap((s) => s.paragraphs).join("\n")
    expect(empty).toMatch(/no bundle in our catalogue is described as no-expiry/i)
    expect(empty).not.toMatch(/The price lists on this page show/)
    expect(empty).not.toMatch(/Standard Bundles/)
    const some = landingSections(e, { rows: 2, standardNoExpiry: false }).flatMap((s) => s.paragraphs).join("\n")
    expect(some).toMatch(/The price lists on this page show/)
    expect(some).not.toMatch(/no bundle in our catalogue/i)
  })

  it("mentions the dashboard Standard Bundles No Expiry category only when it is on sale", () => {
    const on = landingSections(e, { rows: 0, standardNoExpiry: true }).flatMap((s) => s.paragraphs).join("\n")
    expect(on).toMatch(/Standard Bundles/)
    expect(on).toMatch(/No Expiry category/)
  })
})

describe("become-a-data-reseller", () => {
  const e = getLanding("become-a-data-reseller")
  const join = PRODUCTS.find((p) => p.key === "join")!

  it("has no price list and no live price source", () => {
    expect(e.showsPrices).toBe(false)
    expect(landingGroups(e, facts())).toEqual([])
  })

  it("is ok whatever the packages read did (it shows no prices)", () => {
    expect(landingAvailability(e, facts())).toBe("ok")
    expect(landingAvailability(e, FALLBACK_FACTS)).toBe("ok")
  })

  it("walks through shop, margin, link and payout, and links /join", () => {
    expect(e.steps?.map((s) => s.title)).toEqual(["Create your account", "Open your shop", "Set your margin", "Share your shop link", "Get paid"])
    expect(e.relatedProducts[0]).toBe("join")
    const t = allText(e)
    for (const topic of [/sub-agent/i, /withdraw/i, /cost price/i, /reviewed/i, /Mobile Money/]) expect(t).toMatch(topic)
    expect(t).toMatch(/cannot promise any/)
  })

  it("does not compete with /join for the same title, H1 or description", () => {
    expect(join.title).not.toMatch(/become a data reseller/i)
    expect(join.h1).not.toMatch(/become a data reseller/i)
    expect(e.title).toMatch(/become a data reseller/i)
    expect(e.h1.toLowerCase()).not.toBe(join.h1.toLowerCase())
    expect(join.faqs.map((f) => f.question)).not.toEqual(expect.arrayContaining(e.faqs.map((f) => f.question)))
  })
})

describe("at-ishare-data", () => {
  const e = getLanding("at-ishare-data")

  it("shows only the AT iShare group the dashboard sells, at the adjusted price", () => {
    const f = facts({
      priceAdjustments: { ...ZERO_ADJ, price_adjustment_at_ishare: 10 },
      packages: [
        ...PACKAGES,
        { network: "AT - iShare", size: "2", price: 7, is_available: true },
        // not a dashboard network value: main's price groups leave it out
        { network: "AT-iShare", size: "3", price: 10, is_available: true },
      ],
    })
    expect(flat(landingGroups(e, f))).toEqual(["AT - iShare|1GB|4.4", "AT - iShare|2GB|7.7"])
  })

  it("is off when no iShare row is on sale, failed when the read failed", () => {
    expect(landingAvailability(e, facts())).toBe("ok")
    expect(landingAvailability(e, facts({ packages: PACKAGES.filter((p) => !/ishare/i.test(p.network)) }))).toBe("off")
    expect(landingAvailability(e, facts({ packages: null }, ["packages"]))).toBe("failed")
  })

  it("sits under the AT data page in the breadcrumb", () => {
    const crumbs = landingCrumbs(e, PRODUCTS.find((p) => p.key === e.parent))
    expect(crumbs.map((c) => c.path)).toEqual(["/", "/services", "/at-data", "/at-ishare-data"])
  })
})

describe("at-bigtime-data", () => {
  const e = getLanding("at-bigtime-data")

  it("shows only the AT BigTime rows", () => {
    const f = facts({ packages: [...PACKAGES, { network: "AT - BigTime", size: "50", price: 120, is_available: true }] })
    expect(flat(landingGroups(e, f))).toEqual(["AT - BigTime|20GB|60", "AT - BigTime|50GB|120"])
  })

  it("is off when no BigTime row is on sale, failed when the read failed", () => {
    expect(landingAvailability(e, facts())).toBe("ok")
    expect(landingAvailability(e, facts({ packages: PACKAGES.filter((p) => !/bigtime/i.test(p.network)) }))).toBe("off")
    expect(landingAvailability(e, facts({ packages: null }, ["packages"]))).toBe("failed")
  })

  it("is independent of iShare: either AT page can be on while the other is off", () => {
    const ishareOnly = facts({ packages: PACKAGES.filter((p) => !/bigtime/i.test(p.network)) })
    expect(landingAvailability(getLanding("at-ishare-data"), ishareOnly)).toBe("ok")
    expect(landingAvailability(e, ishareOnly)).toBe("off")
  })
})

describe("landing pages link each other and share no copy", () => {
  it("shares no paragraph between pages", () => {
    const seen = new Map<string, string>()
    for (const e of LANDING_PAGES) {
      for (const s of e.sections) {
        for (const p of s.paragraphs) {
          const t = typeof p === "string" ? p : p.text
          expect(seen.get(t), `${e.key} repeats ${seen.get(t)}: ${t}`).toBeUndefined()
          seen.set(t, e.key)
        }
      }
    }
  })

  it("lists every other live landing page from each page (availableLandings minus itself)", () => {
    const live = availableLandings(facts()).map((e) => e.key)
    expect(live).toEqual(LANDING_PAGES.map((e) => e.key))
  })
})

describe("landingsForProduct (product pages' related guides row)", () => {
  it("links each product page back to the live landing pages that link it", () => {
    const f = facts()
    expect(landingsForProduct("at-data", f).map((e) => e.key)).toEqual([
      "non-expiry-data-bundles",
      "become-a-data-reseller",
      "at-ishare-data",
      "at-bigtime-data",
    ])
    expect(landingsForProduct("cheapest-data", f).map((e) => e.key)).toEqual([
      "non-expiry-data-bundles",
      "at-ishare-data",
      "at-bigtime-data",
    ])
    expect(landingsForProduct("join", f).map((e) => e.key)).toEqual([
      "become-a-data-reseller",
      "at-ishare-data",
      "at-bigtime-data",
    ])
    expect(landingsForProduct("airtime", f)).toEqual([])
  })

  it("never links an off or failed landing page", () => {
    expect(landingsForProduct("at-data", FALLBACK_FACTS).map((e) => e.key)).toEqual(["become-a-data-reseller"])
  })

  it("every landing page is linked back from each product page it links", () => {
    const f = facts()
    for (const e of LANDING_PAGES) {
      for (const k of e.relatedProducts) expect(landingsForProduct(k, f).map((x) => x.key), `${k} -> ${e.key}`).toContain(e.key)
    }
  })
})
