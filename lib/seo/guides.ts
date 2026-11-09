/**
 * Static how-to guides. Pure data + lookups, no I/O.
 *
 * `published: false` keeps a guide out of the site, the sitemap, llms.txt and
 * `generateStaticParams`. check-data-balance stays unpublished (and carries no
 * USSD balance codes) until the owner supplies the verified codes.
 *
 * Channel mentions (WhatsApp / USSD) are NOT written here: the guide page adds
 * them from live facts so they only appear when those channels are available.
 */
import { payFaq, refundFaq, speedFaq, type Faq, type ProductKey } from "./products"

export interface GuideSection {
  heading: string
  paragraphs: string[]
  steps?: string[]
}

export interface Guide {
  slug: string
  title: string
  description: string
  h1: string
  published: boolean
  sections: GuideSection[]
  faqs: Faq[]
  related: ProductKey[]
  /** YYYY-MM-DD, used for Article dateModified. */
  updated: string
}

export const GUIDES: Guide[] = [
  {
    slug: "buy-data-with-momo",
    title: "How to Buy Data with MoMo in Ghana | DATAGOD",
    description:
      "Step-by-step guide to buying MTN, Telecel and AT data in Ghana: fund your wallet with MoMo or card, pick a bundle and track your order on DATAGOD.",
    h1: "How to buy data with MoMo in Ghana",
    published: true,
    sections: [
      {
        heading: "Buy data on the DATAGOD website",
        paragraphs: [
          "You can buy MTN, Telecel and AT data bundles on DATAGOD from your phone or computer. You fund your wallet with MoMo or card, then pay for each bundle from that wallet.",
        ],
        steps: [
          "Create a free DATAGOD account, or log in if you already have one.",
          "Fund your wallet with MoMo or card through Paystack.",
          "Choose the network and the bundle size you want.",
          "Enter the phone number that should receive the data.",
          "Pay for the bundle from your wallet.",
          "Track the order from your dashboard until it is delivered.",
        ],
      },
      {
        heading: "How long does delivery take?",
        paragraphs: ["Usually delivered within minutes.", "If an order fails, you get your money back."],
      },
      {
        heading: "Compare prices before you buy",
        paragraphs: [
          "Bundle prices differ by network and size. Check the current price list for your network, or compare all networks on one page, before you fund your wallet.",
        ],
      },
    ],
    faqs: [
      payFaq("How do I pay for data on DATAGOD?"),
      speedFaq("How long does data delivery take?", "You can track every order from your dashboard or order history."),
      refundFaq(),
      {
        question: "Can I buy data for someone else?",
        answer: "Yes. Enter the other person's phone number when you choose the bundle, and the data goes to that number.",
      },
    ],
    related: ["mtn-data", "telecel-data", "at-data", "cheapest-data"],
    updated: "2026-10-28",
  },
  {
    slug: "check-data-balance",
    title: "How to Check Your Data Balance in Ghana | DATAGOD",
    description:
      "Learn how to check the data balance on your MTN, Telecel or AT line in Ghana, and what to do when your bundle runs low, with DATAGOD.",
    h1: "How to check your data balance in Ghana",
    published: false,
    sections: [
      {
        heading: "Check your balance",
        paragraphs: [
          "Each network lets you check your remaining data from your phone. The exact steps for each network will be added here once they are confirmed.",
        ],
      },
      {
        heading: "When your data runs low",
        paragraphs: [
          "When your bundle is nearly finished, you can buy more on DATAGOD. Fund your wallet with MoMo or card, choose a bundle and pay from your wallet.",
        ],
      },
    ],
    faqs: [
      speedFaq("How long does a new bundle take to arrive?"),
      refundFaq(),
      payFaq(),
      {
        question: "Can I top up before my data finishes?",
        answer: "Yes. You can buy a new bundle for your number at any time.",
      },
    ],
    related: ["mtn-data", "telecel-data", "at-data"],
    updated: "2026-10-28",
  },
]

export function publishedGuides(): Guide[] {
  return GUIDES.filter((g) => g.published)
}

export function getPublishedGuide(slug: string): Guide | null {
  return publishedGuides().find((g) => g.slug === slug) ?? null
}
