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

export type LandingKey =
  | "data-bundle-prices"
  | "non-expiry-data-bundles"
  | "become-a-data-reseller"
  | "at-ishare-data"

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
  {
    key: "non-expiry-data-bundles",
    path: "/non-expiry-data-bundles",
    name: "Non-Expiry Data Bundles",
    h1: "Non-expiry data bundles in Ghana",
    title: "Non-Expiry Data Bundles in Ghana | DATAGOD",
    description:
      "See which data bundles on DATAGOD don't expire, network by network, with live prices. Pay from your wallet, funded with MoMo or card.",
    lede:
      "A non-expiry data bundle stays on your line until you use it up, instead of running out after a set number of days. This page lists every data bundle DATAGOD sells right now whose catalogue description says it does not expire, with the price you pay from your wallet.",
    kind: "non-expiry",
    source: "packages",
    sections: [
      {
        heading: "What a non-expiry bundle is",
        paragraphs: [
          "Most data bundles in Ghana come with a validity: a daily, weekly or monthly window after which any data left over is lost. A non-expiry bundle has no such window. The data stays available until you have used all of it, so a bundle bought today can still be in use weeks later.",
          "That suits people who only go online now and then: a phone kept mainly for calls, a second SIM, a parent who checks WhatsApp in the evening, or a student between semesters. If you use a lot of data every day you will finish most bundles long before they expire, so compare sizes and prices across all bundles too.",
          "The network's own terms for each bundle still apply, so read the bundle details in the dashboard before you confirm an order.",
        ],
      },
      {
        heading: "Which DATAGOD bundles don't expire",
        paragraphs: [
          {
            when: "has-rows",
            text: "The tables on this page show only bundles whose description in our catalogue says no expiry. Each table is one network, sorted from the smallest size to the largest, and the price is the standard price you pay from your DATAGOD wallet. When a bundle sells out it drops off the table until it is back.",
          },
          {
            when: "no-rows",
            text: "Right now no bundle in our catalogue is described as no-expiry, so there is no table on this page. Rather than guess from a bundle's name, we wait until its description says so. The network pages list every bundle on sale, with its validity wherever our catalogue records one.",
          },
          "A bundle without a validity listed is not automatically non-expiry. If you need data that lasts, buy from the rows marked No expiry, or check the validity shown in the dashboard before you pay.",
          {
            when: "standard-no-expiry",
            text: "Logged-in customers can also buy Telecel bundles from Standard Bundles in the DATAGOD dashboard. That section lists bundles from Telecel's own catalogue grouped by category, and Telecel bundles sold without an expiry date sit under the No Expiry category. The price of each one is shown in the dashboard before you pay.",
          },
        ],
      },
      {
        heading: "How to buy a non-expiry bundle",
        paragraphs: [
          `Create a free DATAGOD account or log in, fund your wallet with Mobile Money (MoMo) or a card through Paystack, then pick the bundle and enter the number it should go to. The bundle has to match that number's network. ${PREFIXES}`,
          "Every order is saved in your order history, so you can see when it was delivered. Reselling? Bundles that don't expire are worth offering to customers who dislike losing unused data, and you can add them to your DATAGOD shop at your own price.",
        ],
      },
    ],
    faqs: [
      {
        question: "What is a non-expiry data bundle?",
        answer:
          "A bundle with no validity window: the data stays on the line until it is used up, instead of being lost after a set number of days.",
      },
      {
        question: "Which networks have non-expiry bundles on DATAGOD?",
        answer:
          "The networks with a table on this page. We only list a bundle here when its description in our catalogue says no expiry, and the list changes as bundles go in and out of stock.",
      },
      {
        question: "Do non-expiry bundles ever run out?",
        answer: "They run out when you have used all the data. The network's own terms for the bundle still apply.",
      },
      speedFaq("How fast is a non-expiry bundle delivered?", "You can track every order from your order history."),
      refundFaq(),
      payFaq(),
    ],
    relatedProducts: ["mtn-data", "telecel-data", "at-data"],
    footerLabel: "Non-expiry data",
    priority: 0.7,
    updated: "2026-11-01",
  },
  {
    key: "become-a-data-reseller",
    path: "/become-a-data-reseller",
    name: "Become a Data Reseller",
    h1: "Become a data reseller in Ghana – start a data business",
    title: "Become a Data Reseller in Ghana: Start a Business | DATAGOD",
    description:
      "How to start a data reselling business in Ghana with DATAGOD: open a shop, set your margin, share your link, add sub-agents and withdraw profit to MoMo.",
    lede:
      "Reselling data means buying bundles at one price and selling them at a little more to people who already know you. This guide explains how that works on DATAGOD, from opening a shop and setting your margin to recruiting sub-agents and withdrawing your profit, so you know what to expect before you sign up.",
    kind: "reseller",
    source: null,
    steps: [
      { title: "Create your account", body: "Sign up for a free DATAGOD account. The same account runs your wallet, your orders and your shop." },
      {
        title: "Open your shop",
        body: "Create your shop from the dashboard and give it a name and logo. New shops are reviewed by the DATAGOD team before they go live on your shop link.",
      },
      {
        title: "Set your margin",
        body: "Enter a selling price for each bundle. Your cost price is shown beside it and your price cannot go below it; the difference is your profit on each sale.",
      },
      {
        title: "Share your shop link",
        body: "Post your link on WhatsApp, social media or flyers. Customers buy as guests and pay with MoMo or card, with no account needed.",
      },
      {
        title: "Get paid",
        body: "Profit from your sales builds up in your shop balance, and you withdraw it to Mobile Money or a bank account from the dashboard.",
      },
    ],
    sections: [
      {
        heading: "What a data reseller does",
        paragraphs: [
          "Your customers are usually people who would rather message someone they know than buy data themselves: friends, classmates, co-workers, church members or a whole neighbourhood. You do not buy bundles in advance for your shop. When a customer orders and pays through your shop link, the bundle is sent to their number and your margin is recorded in your shop balance.",
        ],
      },
      {
        heading: "How your profit is worked out",
        paragraphs: [
          "Every bundle has a cost price, what DATAGOD charges your shop for it, and a selling price, which you choose. For a normal account the cost price is the standard price on our data bundle price list; accounts upgraded to dealer pay dealer prices, a lower cost per bundle. You can price bundles one by one or update a whole network at once.",
          "We cannot promise any level of sales or income. What you earn depends on your prices and on how many people buy from you, and customers do compare, so pick prices they will accept.",
        ],
      },
      {
        heading: "Growing with sub-agents",
        paragraphs: [
          "Once your shop is running you can bring in sub-agents: resellers who sell under your shop. Send them an invite link, or let them request to join from your shop and approve them. In your sub-agent catalog you set the price your sub-agents pay for each bundle; they add their own margin for their customers, and the difference between your cost and their price is your profit on their sales. Sub-agents cannot recruit sub-agents of their own.",
          "Not every customer has data to open a link. A shop can activate a 4-digit USSD shop code so customers can buy from you on any phone, and add a WhatsApp ordering bot from the dashboard.",
        ],
      },
      {
        heading: "Getting paid",
        paragraphs: [
          "Withdrawals go from your shop balance to Mobile Money (MoMo) or a bank account. The withdrawal fee and minimum amount are shown before you confirm, and the account name is checked so the money reaches the right person. A new shop waits a short period before its first withdrawal and there is a gap between withdrawals; the dashboard tells you when you can request the next one. Your profit log lists every earning and withdrawal with a running balance.",
          "Ready? Our join page takes you through creating your account and opening your shop.",
        ],
      },
    ],
    faqs: [
      {
        question: "Do I need money to start reselling data?",
        answer:
          "You do not buy bundles in advance for your shop: your customers pay when they order from your shop link. Optional extras, such as a WhatsApp ordering bot, show their fee in the dashboard before you pay.",
      },
      {
        question: "How much can I earn?",
        answer:
          "That depends on the prices you set and how many people buy from you, so we cannot promise any amount. Your profit on each sale is your selling price minus your cost price, and every earning is listed in your profit log.",
      },
      {
        question: "How do I withdraw my profit?",
        answer:
          "Request a withdrawal from your shop balance to Mobile Money or a bank account. The fee and the minimum amount are shown before you confirm.",
      },
      {
        question: "Can I resell under someone else's shop?",
        answer:
          "Yes. If another reseller sends you an invite link, use it to join as their sub-agent. You then buy at the price they set for you and sell to your own customers at your own price.",
      },
      speedFaq("How fast do my customers get their data?", "Customers can track their order from your shop."),
      refundFaq("What if a customer's order fails?"),
    ],
    relatedProducts: ["join", "mtn-data", "telecel-data", "at-data", "ussd"],
    footerLabel: "Become a data reseller",
    priority: 0.8,
    updated: "2026-11-01",
  },
  {
    key: "at-ishare-data",
    path: "/at-ishare-data",
    name: "AT iShare Data Bundles",
    h1: "AT iShare data bundles",
    title: "AT iShare Data Bundles: Prices in Ghana | DATAGOD",
    description:
      "Buy AT iShare data bundles in Ghana from your DATAGOD wallet, funded with MoMo or card. Live iShare prices, sent to the AT number you choose.",
    lede:
      "AT iShare bundles are one of the AT data products DATAGOD sells. Pick an iShare bundle from the table, enter the AT number it should go to and pay from your wallet. The table lists only the iShare bundles on sale right now, with the price you pay for each.",
    kind: "at-type",
    atType: "iShare",
    source: "packages",
    parent: "at-data",
    sections: [
      {
        heading: "How AT iShare bundles work on DATAGOD",
        paragraphs: [
          "iShare is AT's data-sharing service: the bundle you choose is shared onto the AT number you enter, which can be your own line or someone else's. You do not need an AT line yourself to buy, only the number the data should go to.",
          "AT numbers start with 026, 027, 056 or 057. Check the number twice before you pay, because data shared to the wrong line cannot be taken back.",
          "Our catalogue lists iShare separately from AT's other data products, so every row here is an iShare bundle. Where a row's description records how long the bundle lasts, the validity appears next to the size.",
        ],
      },
      {
        heading: "Choosing an iShare bundle",
        paragraphs: [
          "The table runs from the smallest iShare bundle to the largest. Think about how much the person on the receiving line uses: a few messages a day needs far less than streaming or working online, and buying a smaller bundle more often avoids paying for data that goes unused.",
          "Comparing with other AT data? The AT data page lists every AT bundle we sell, grouped by type, so you can see the iShare rows next to the rest.",
        ],
      },
      {
        heading: "Paying and tracking your order",
        paragraphs: [
          "Fund your DATAGOD wallet with Mobile Money (MoMo) or a card through Paystack, then buy iShare bundles from that balance. One MoMo approval tops up the wallet and each bundle after that is paid from your balance, which makes it easy to share data to several numbers in one sitting.",
          "Every order appears in your order history with its status, so you can see when the data has been shared. If something looks wrong, our support team is on WhatsApp.",
        ],
      },
      {
        heading: "Selling AT iShare data",
        paragraphs: [
          "Resellers can add AT iShare bundles to their DATAGOD shop, set a selling price above their cost and let customers order from the shop link. Our reseller guide explains how margins, sub-agents and withdrawals work.",
        ],
      },
    ],
    faqs: [
      {
        question: "What is AT iShare?",
        answer: "It is AT's data-sharing service. When you buy an iShare bundle on DATAGOD, the data is shared onto the AT number you enter.",
      },
      {
        question: "Can I buy iShare data for another person?",
        answer: "Yes. Enter their AT number when you order. Make sure it is an AT number, starting 026, 027, 056 or 057.",
      },
      speedFaq("How fast is AT iShare data delivered?", "You can track every order from your order history."),
      refundFaq(),
      payFaq(),
      {
        question: "Why can't I see the iShare bundle I want?",
        answer: "The table only lists iShare bundles on sale right now. A size that is out of stock drops off until it is back.",
      },
    ],
    relatedProducts: ["at-data", "mtn-data", "telecel-data", "join"],
    footerLabel: "AT iShare data",
    priority: 0.7,
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
