/**
 * JSON-LD for public product pages: Service (+ Offer when the product is on and
 * a live "from" price is known, + OfferCatalog on data pages with a price
 * table), FAQPage and
 * BreadcrumbList. Pure.
 *
 * Never emits ratings or reviews: DATAGOD has no verified review data, and
 * fabricated AggregateRating markup is a Google structured-data violation.
 */
import { absoluteUrl, SITE_URL } from "./site"
import type { Faq, ProductEntry } from "./products"
import type { ProductFacts } from "./live-facts"
import { rowLabel, type PriceRow } from "./data-prices"

const CONTEXT = "https://schema.org"

/** Schema.org Offer price: 2 decimals from GH₵1 up, 3 below (0.025 -> "0.025"). */
export function offerPrice(n: number): string {
  return n < 1 ? n.toFixed(3) : n.toFixed(2)
}

/** Stable node ids: the site-wide Organization / WebSite nodes and every reference to them. */
export const ORG_ID = `${SITE_URL}/#org`
export const WEBSITE_ID = `${SITE_URL}/#website`

const LOGO = absoluteUrl("/favicon-v2.jpeg")

/**
 * The organization as referenced from page-level nodes (Service.provider).
 * Same @id as the full node in buildSiteJsonLd(), so Google merges them.
 */
export const DATAGOD_ORGANIZATION = {
  "@type": "Organization",
  "@id": ORG_ID,
  name: "DATAGOD",
  url: SITE_URL,
  logo: LOGO,
} as const

const SAME_AS = [
  "https://web.facebook.com/datagod.store",
  "https://twitter.com/datagodstore",
  "https://www.instagram.com/datagodstore",
] as const

/**
 * Support contact: the defaults app/api/support-config/route.ts already serves
 * (and the onboarding support step links to). Keep in step with those.
 */
const SUPPORT_EMAIL = "datagod.store@gmail.com"
const SUPPORT_PHONE = "+233559919037"

/**
 * Site-wide JSON-LD for the root layout, main host only: ONE Organization and
 * ONE WebSite (publisher -> the Organization). No SearchAction (the site has
 * no search results page), no SiteNavigationElement, and no LocalBusiness:
 * re-add LocalBusiness only with a real street address and phone that match
 * the Google Business Profile.
 */
export function buildSiteJsonLd(): object[] {
  return [
    {
      "@context": CONTEXT,
      ...DATAGOD_ORGANIZATION,
      description: "Data bundles, airtime, bill payments, results checkers and bulk SMS in Ghana.",
      sameAs: [...SAME_AS],
      contactPoint: {
        "@type": "ContactPoint",
        contactType: "customer support",
        email: SUPPORT_EMAIL,
        telephone: SUPPORT_PHONE,
        areaServed: "GH",
        availableLanguage: ["en"],
      },
    },
    {
      "@context": CONTEXT,
      "@type": "WebSite",
      "@id": WEBSITE_ID,
      name: "DATAGOD",
      url: SITE_URL,
      inLanguage: "en-GH",
      publisher: { "@id": ORG_ID },
    },
  ]
}

/**
 * OfferCatalog over the same rows the page's price table shows: one GHS Offer
 * per row, at packages.price. null when there are no rows (no table, no catalog).
 */
export function buildOfferCatalog(p: ProductEntry, rows: readonly PriceRow[]): object | null {
  const valid = rows.filter((r) => typeof r.price === "number" && Number.isFinite(r.price) && r.price > 0)
  if (valid.length === 0) return null
  const url = absoluteUrl(p.path)
  return {
    "@type": "OfferCatalog",
    name: `${p.name} prices`,
    itemListElement: valid.map((r) => ({
      "@type": "Offer",
      name: rowLabel(r),
      price: offerPrice(r.price),
      priceCurrency: "GHS",
      availability: "https://schema.org/InStock",
      url,
    })),
  }
}

export function buildServiceJsonLd(p: ProductEntry, f: ProductFacts, rows: readonly PriceRow[] = []): object {
  const url = absoluteUrl(p.path)
  // A product that is switched off has nothing on offer: no Offer, no OfferCatalog.
  const catalog = f.available ? buildOfferCatalog(p, rows) : null
  const hasPrice = f.available && typeof f.fromPrice === "number" && Number.isFinite(f.fromPrice) && f.fromPrice > 0
  return {
    "@context": CONTEXT,
    "@type": "Service",
    name: p.name,
    description: p.description,
    url,
    serviceType: p.name,
    provider: DATAGOD_ORGANIZATION,
    areaServed: { "@type": "Country", name: "Ghana" },
    ...(hasPrice && {
      offers: {
        "@type": "Offer",
        price: offerPrice(f.fromPrice as number),
        priceCurrency: "GHS",
        availability: "https://schema.org/InStock",
        url,
      },
    }),
    ...(catalog && { hasOfferCatalog: catalog }),
  }
}

export function buildFaqJsonLd(faqs: readonly Faq[]): object {
  return {
    "@context": CONTEXT,
    "@type": "FAQPage",
    mainEntity: faqs.map((q) => ({
      "@type": "Question",
      name: q.question,
      acceptedAnswer: { "@type": "Answer", text: q.answer },
    })),
  }
}

export interface Crumb { name: string; path: string }

export function buildBreadcrumbJsonLd(crumbs: readonly Crumb[]): object {
  return {
    "@context": CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: absoluteUrl(c.path),
    })),
  }
}

/** Home -> Services -> product. */
export function productCrumbs(p: ProductEntry): Crumb[] {
  return [
    { name: "Home", path: "/" },
    { name: "Services", path: "/services" },
    { name: p.name, path: p.path },
  ]
}

/** `rows`: the page's live price-table rows (data pages only); adds a Service OfferCatalog. */
export function buildProductJsonLd(p: ProductEntry, f: ProductFacts, rows: readonly PriceRow[] = []): object[] {
  return [buildServiceJsonLd(p, f, rows), buildFaqJsonLd(p.faqs), buildBreadcrumbJsonLd(productCrumbs(p))]
}
