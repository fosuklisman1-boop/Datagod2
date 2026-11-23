import type { V2DocSection } from "./registry"

export type DocSlug = "data" | "airtime" | "bills" | "bundles" | "results" | "afa" | "sms"

export interface DocPage {
  slug: DocSlug
  title: string
  description: string
  sectionIds: readonly string[]
}

// The seven registry `start` sections, plus the sandbox failure numbers rendered by the hub itself.
export const HUB_SECTION_IDS: readonly string[] = [
  "overview",
  "authentication",
  "key-types",
  "response-format",
  "errors-and-limits",
  "idempotency",
  "sandbox",
  "sandbox-failures",
]

export const DOC_PAGES: readonly DocPage[] = [
  {
    slug: "data",
    title: "Data and wallet",
    description:
      "Check your account and wallet, list data packages, buy single or bulk data bundles, verify numbers and track orders through every status.",
    sectionIds: [
      "account",
      "wallet",
      "packages",
      "data-purchase",
      "data-bulk",
      "data-verify",
      "data-orders",
      "order-statuses",
      "bulk-orders",
    ],
  },
  {
    slug: "airtime",
    title: "Airtime",
    description:
      "Sell airtime from your wallet: see the price you pay, buy for any Ghana network with a safe idempotency reference, and track each airtime order.",
    sectionIds: ["commission-idempotency", "airtime-pricing", "airtime-purchase", "airtime-orders"],
  },
  {
    slug: "bills",
    title: "Utility bills",
    description:
      "Pay electricity, water and TV bills through the API: list billers, look up the customer account, pay from your wallet and follow each payment.",
    sectionIds: ["bill-payment-flow", "utility-billers", "utility-lookup", "utility-pay", "utility-orders"],
  },
  {
    slug: "bundles",
    title: "Standard Bundles",
    description:
      "Browse the Standard Bundles catalog, buy a bundle for a customer number from your wallet, and track bundle orders until they complete or fail.",
    sectionIds: ["bundles-overview", "bundles-catalog", "bundles-purchase", "bundles-orders"],
  },
  {
    slug: "results",
    title: "Results checker",
    description:
      "Buy WAEC and other results checker vouchers by API, receive the PINs once, retry safely with an idempotency reference and read past voucher orders.",
    sectionIds: ["voucher-pins", "results-idempotency", "results-types", "results-purchase", "results-orders"],
  },
  {
    slug: "afa",
    title: "AFA registration",
    description:
      "Register customers for AFA through the API with one call from your wallet, then check each registration order for its status and any failure reason.",
    sectionIds: ["afa-registration", "afa-register", "afa-orders"],
  },
  {
    slug: "sms",
    title: "SMS",
    description:
      "Send single and bulk SMS from your own sender ID, check your SMS balance, list senders and campaigns, and test everything safely in the sandbox.",
    sectionIds: ["sms-overview", "sms-send", "sms-balance", "sms-senders", "sms-campaigns", "sms-idempotency", "sms-sandbox"],
  },
]

export const STATIC_DOC_PAGES: readonly {
  slug: "go-live" | "starter-kits" | "errors" | "changelog"
  title: string
  description: string
}[] = [
  { slug: "go-live", title: "Go live", description: "Checklist for moving from test keys to live keys." },
  { slug: "starter-kits", title: "Starter kits", description: "Ready-made code samples and the Postman collection." },
  { slug: "errors", title: "Errors", description: "Every documented error, with what it means and what to do." },
  { slug: "changelog", title: "Changelog", description: "What changed in the API and when." },
]

export function docPath(slug?: string): string {
  return slug ? `/developers/${slug}` : "/developers"
}

/** null = the hub, undefined = unknown section id. */
export function pageSlugForSection(sectionId: string): DocSlug | null | undefined {
  if (HUB_SECTION_IDS.includes(sectionId)) return null
  return DOC_PAGES.find((p) => p.sectionIds.includes(sectionId))?.slug
}

export function sectionsForPage(registry: V2DocSection[], slug: DocSlug | null): V2DocSection[] {
  return registry.filter((s) => pageSlugForSection(s.id) === slug)
}

export function sectionHref(sectionId: string): string {
  const slug = pageSlugForSection(sectionId)
  return `${docPath(slug ?? undefined)}#${sectionId}`
}

export function endpointHref(registry: V2DocSection[], endpointId: string): string {
  const section = registry.find((s) => s.endpoints.some((e) => e.id === endpointId))
  const slug = section ? pageSlugForSection(section.id) : null
  return `${docPath(slug ?? undefined)}#endpoint-${endpointId}`
}
