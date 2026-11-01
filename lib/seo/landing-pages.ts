/**
 * Landing-page registry: server-rendered keyword pages that sit next to the
 * product pages (lib/seo/products.ts) but are not products themselves. Each
 * one answers a search ("data bundle prices Ghana", "become a data reseller")
 * over data and products that already exist: the public price tables
 * (LiveFacts.dataPrices, i.e. packages.price) and the reseller features.
 *
 * Why a sibling registry and not PRODUCTS: a ProductEntry is a thing we sell,
 * with its own LiveFacts.products entry, Service/Offer JSON-LD, a group whose
 * pages must all link each other, and a place on /services. Landing pages have
 * none of that: their availability is derived from the rows they show (an AT
 * iShare page is only "ok" while iShare rows are on sale), and they emit an
 * OfferCatalog over those rows instead of a Service. The discovery surfaces
 * (sitemap, llms.txt, footer, related rows) read both registries.
 *
 * Static copy, no I/O. Copy rules (enforced by landing-pages.test.ts, the same
 * rules as products.ts and data-page-copy.ts):
 *  - title <= 60 chars ending "| DATAGOD", description 120-160 chars
 *  - 300-600 words of page copy (lede + sections), whichever conditional paragraphs show
 *  - no prices, amounts, ratings, percentages or USSD codes: prices come only from the tables
 *  - never "instant", "in seconds" or "automatic refund"
 *  - FAQs carry REFUND_LINE and SPEED_LINE verbatim
 */
import { PAY_LINE, REFUND_LINE, SPEED_LINE, type Faq, type ProductKey } from "./products"
import type { FactSource, LiveFacts } from "./live-facts"
import { DATA_NETS, type DataNet, type DataPriceTables, type PriceRow } from "./data-prices"

export type LandingKey = "data-bundle-prices"

/**
 * - "prices":     every public data row, one table per network
 * - "non-expiry": only rows whose description says no expiry
 * - "reseller":   no table; the reseller guide
 * - "at-type":    the AT rows of one AT sub-product (atType)
 */
export type LandingKind = "prices" | "non-expiry" | "reseller" | "at-type"

/**
 * When a conditional paragraph shows:
 * - "has-rows" / "no-rows": the page's own table rows (after filtering)
 * - "standard-no-expiry":  the dashboard Standard Bundles sell Telecel with its No Expiry category visible
 *   (lib/seo/standard-bundles-facts.ts)
 */
export type ParagraphCondition = "has-rows" | "no-rows" | "standard-no-expiry"
export type Paragraph = string | { when: ParagraphCondition; text: string }

export interface LandingSection {
  heading: string
  paragraphs: Paragraph[]
}

export interface LandingStep {
  title: string
  body: string
}

export interface LandingEntry {
  key: LandingKey
  path: string
  /** Short name: breadcrumb, related cards, llms.txt. */
  name: string
  h1: string
  /** <= 60 chars, ends "| DATAGOD" */
  title: string
  /** 120-160 chars */
  description: string
  /** Opening paragraph under the H1. */
  lede: string
  kind: LandingKind
  /** AT sub-product shown by an "at-type" page (matches PriceRow.type). */
  atType?: "iShare" | "BigTime"
  /** The LiveFacts source the page's data comes from; null when it shows no live data. */
  source: FactSource | null
  /** Numbered steps (the reseller guide). */
  steps?: LandingStep[]
  sections: LandingSection[]
  /** 4-8, with the verbatim refund and speed lines. */
  faqs: Faq[]
  /** Product pages this page links to; those pages link back (components/seo/related-guides.tsx). */
  relatedProducts: ProductKey[]
  /** Product page shown between Services and this page in the breadcrumb. */
  parent?: ProductKey
  /** Label in the homepage footer "Buy online" block. */
  footerLabel: string
  /** sitemap priority */
  priority: number
  /** YYYY-MM-DD the copy or template last changed (sitemap lastmod). Bump by hand. */
  updated: string
}

const refundFaq = (question = "What happens if my order fails?", extra = ""): Faq => ({
  question,
  answer: `${REFUND_LINE}${extra ? ` ${extra}` : ""}`,
})
const speedFaq = (question: string, extra = ""): Faq => ({
  question,
  answer: `${SPEED_LINE}${extra ? ` ${extra}` : ""}`,
})
const payFaq = (question = "How do I pay?", extra = ""): Faq => ({
  question,
  answer: `${PAY_LINE}${extra ? ` ${extra}` : ""}`,
})

const PREFIXES =
  "MTN numbers start with 024, 025, 053, 054, 055 or 059, Telecel numbers with 020 or 050, and AT numbers with 026, 027, 056 or 057."

export const LANDING_PAGES: readonly LandingEntry[] = [
  {
    key: "data-bundle-prices",
    path: "/data-bundle-prices",
    name: "Data Bundle Prices",
    h1: "Data bundle prices in Ghana (MTN, Telecel, AT)",
    title: "Data Bundle Prices in Ghana (MTN, Telecel, AT) | DATAGOD",
    description:
      "Compare MTN, Telecel and AT data bundle prices in Ghana on one page. Live prices from the DATAGOD catalogue, paid from a wallet you fund with MoMo or card.",
    lede:
      "Compare every data bundle DATAGOD sells on MTN, Telecel and AT, side by side, with the price you pay for each one from your wallet. The tables come straight from our live catalogue, so a bundle that is out of stock is simply not listed.",
    kind: "prices",
    source: "packages",
    sections: [
      {
        heading: "How to read these prices",
        paragraphs: [
          "Each price is the standard price a DATAGOD account pays from its wallet, in Ghana cedis. It is the price you see at checkout, with nothing added at the end. Bundles are listed from the smallest size to the largest, and where our catalogue records how long a bundle lasts, the validity sits next to the size so you can compare like with like.",
          "Where a network sells more than one kind of data product, the table adds a Type column and lists each type separately. Compare sizes within the same type, because two bundles of the same size can be different products.",
          "The tables are refreshed from our catalogue regularly. If a price changes or a bundle sells out in the meantime, the dashboard always shows the current price before you confirm an order.",
        ],
      },
      {
        heading: "Choosing the right bundle",
        paragraphs: [
          "Start with how you use data. Someone who mostly chats on WhatsApp needs far less than someone who streams video or works online, so a light user can be better off with a smaller bundle bought when needed than with one large bundle. If a bundle has a validity, compare it with how quickly you normally use data: a bundle that expires before you finish it is not good value, however low the price per gigabyte looks.",
          `Check the network before you choose, because a bundle can only go to a number on its own network. ${PREFIXES}`,
        ],
      },
      {
        heading: "How to buy a bundle from these tables",
        paragraphs: [
          "Create a free DATAGOD account or log in, then fund your wallet with Mobile Money (MoMo) or a card through Paystack. Pick the network and the bundle, type the number that should receive the data and pay from your wallet balance. You approve one MoMo prompt when you top up, not one for every bundle, so buying for the whole family or office takes one sitting.",
          "Every order is saved in your order history, where you can follow it until it is delivered. Each network page explains the other ways to order too, such as WhatsApp.",
          "Selling data to friends or customers? A DATAGOD shop lets you set your own selling price for each bundle and keep the difference. Our reseller guide explains how it works.",
        ],
      },
    ],
    faqs: [
      {
        question: "Are these the prices I pay?",
        answer:
          "Yes. Each price is the standard price charged to your DATAGOD wallet for that bundle, in Ghana cedis. The dashboard shows the current price again before you confirm.",
      },
      {
        question: "Which network has the cheapest data?",
        answer:
          "It depends on the size and how long the bundle lasts, so compare the same size across the tables. The prices come from our live catalogue, so you are always comparing what is on sale now.",
      },
      speedFaq("How fast is the data delivered?", "You can track every order from your order history."),
      refundFaq(),
      payFaq(),
      {
        question: "Why is a bundle missing from the table?",
        answer: "Only bundles on sale right now are listed. When a size is out of stock it drops off the table until it is back.",
      },
    ],
    relatedProducts: ["mtn-data", "telecel-data", "at-data", "join"],
    footerLabel: "Data bundle prices",
    priority: 0.8,
    updated: "2026-11-01",
  },
]

const BY_KEY = new Map<LandingKey, LandingEntry>(LANDING_PAGES.map((e) => [e.key, e]))

export function getLanding(key: LandingKey): LandingEntry {
  const e = BY_KEY.get(key)
  if (!e) throw new Error(`Unknown landing page key: ${key}`)
  return e
}

/** The landing page at `path` ("/data-bundle-prices", trailing slash ignored), if any. */
export function findLandingByPath(path: string | null | undefined): LandingEntry | undefined {
  if (!path) return undefined
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path
  return LANDING_PAGES.find((e) => e.path === p)
}

/**
 * The rows a landing page shows, in network order (each network already
 * sorted by buildPriceTables). Empty when it shows none or the read failed.
 */
export function landingRows(e: LandingEntry, tables: DataPriceTables | null): PriceRow[] {
  if (!tables) return []
  switch (e.kind) {
    case "prices":
      return DATA_NETS.flatMap((n) => tables[n])
    case "non-expiry":
      return DATA_NETS.flatMap((n) => tables[n].filter((r) => r.validity === "No expiry"))
    case "at-type":
      return tables.AT.filter((r) => r.type === e.atType)
    case "reseller":
      return []
  }
}

/** Rows grouped per network, networks without rows left out, in DATA_NETS order. */
export function rowsByNetwork(rows: readonly PriceRow[]): Array<{ network: DataNet; rows: PriceRow[] }> {
  return DATA_NETS.map((network) => ({ network, rows: rows.filter((r) => r.network === network) })).filter(
    (g) => g.rows.length > 0,
  )
}

/** Same three states as product pages (lib/seo/page-meta.ts PageAvailability). */
export type LandingAvailability = "ok" | "off" | "failed"

/**
 * - "failed": the page's source could not be read -> 5xx (crawlers retry).
 * - "off":    nothing to show right now (no rows of a page that is a price
 *             list, or the reseller program is off) -> 200 with a notice,
 *             left out of the sitemap, footer and related rows.
 * - "ok":     render normally. The non-expiry page is always "ok" once read:
 *             with no rows it says so honestly.
 */
export function landingAvailability(e: LandingEntry, facts: LiveFacts): LandingAvailability {
  if (e.source !== null && (facts.failedSources ?? []).includes(e.source)) return "failed"
  if (e.source === "packages" && facts.dataPrices === null) return "failed"
  switch (e.kind) {
    case "prices":
    case "at-type":
      return landingRows(e, facts.dataPrices).length > 0 ? "ok" : "off"
    case "non-expiry":
      return "ok"
    case "reseller":
      return facts.products.join?.available === true ? "ok" : "off"
  }
}

/** Landing pages that are "ok" right now, in registry order. */
export function availableLandings(facts: LiveFacts, keys?: readonly LandingKey[]): LandingEntry[] {
  const list = keys ? keys.map(getLanding) : [...LANDING_PAGES]
  return list.filter((e) => landingAvailability(e, facts) === "ok")
}

/** Live landing pages that link to product `key` (shown in that product page's related rows). */
export function landingsForProduct(key: ProductKey, facts: LiveFacts): LandingEntry[] {
  return availableLandings(facts).filter((e) => e.relatedProducts.includes(key))
}

export interface ParagraphContext {
  /** Number of rows the page shows. */
  rows: number
  /** The dashboard Standard Bundles sell Telecel with the No Expiry category visible. */
  standardNoExpiry: boolean
}

function shows(p: Paragraph, ctx: ParagraphContext): boolean {
  if (typeof p === "string") return true
  switch (p.when) {
    case "has-rows":
      return ctx.rows > 0
    case "no-rows":
      return ctx.rows === 0
    case "standard-no-expiry":
      return ctx.standardNoExpiry
  }
}

/** The sections with only the paragraphs that apply; sections left empty are dropped. */
export function landingSections(e: LandingEntry, ctx: ParagraphContext): Array<{ heading: string; paragraphs: string[] }> {
  return e.sections
    .map((s) => ({ heading: s.heading, paragraphs: s.paragraphs.filter((p) => shows(p, ctx)).map((p) => (typeof p === "string" ? p : p.text)) }))
    .filter((s) => s.paragraphs.length > 0)
}

/** Every visible word of copy for a context: lede, steps and section paragraphs (FAQs excluded). */
export function landingCopyText(e: LandingEntry, ctx: ParagraphContext): string {
  return [
    e.lede,
    ...(e.steps ?? []).flatMap((s) => [s.title, s.body]),
    ...landingSections(e, ctx).flatMap((s) => [s.heading, ...s.paragraphs]),
  ].join("\n")
}
