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
import type { PriceGroup } from "./data-prices"
import type { LandingEntry } from "./landing-pages"

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

/** AggregateOffer over every listed price, or null when there are none. */
function aggregateOffer(groups: readonly PriceGroup[], url: string): object | null {
  const prices = groups.flatMap((g) => g.rows.map((r) => r.price)).filter((n) => Number.isFinite(n) && n > 0)
  if (prices.length === 0) return null
  return {
    "@type": "AggregateOffer",
    lowPrice: offerPrice(Math.min(...prices)),
    highPrice: offerPrice(Math.max(...prices)),
    offerCount: prices.length,
    priceCurrency: "GHS",
    availability: "https://schema.org/InStock",
    url,
  }
}

export function buildServiceJsonLd(p: ProductEntry, f: ProductFacts, groups: readonly PriceGroup[] = []): object {
  const url = absoluteUrl(p.path)
  // A product that is switched off has nothing on offer: no Offer, no AggregateOffer.
  const hasPrice = f.available && typeof f.fromPrice === "number" && Number.isFinite(f.fromPrice) && f.fromPrice > 0
  const aggregate = f.available && p.group === "data" ? aggregateOffer(groups, url) : null
  if (aggregate) {
    return {
      "@context": CONTEXT,
      "@type": "Service",
      name: p.name,
      description: p.description,
      url,
      serviceType: p.name,
      provider: DATAGOD_ORGANIZATION,
      areaServed: { "@type": "Country", name: "Ghana" },
      offers: aggregate,
    }
  }
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

export function buildProductJsonLd(p: ProductEntry, f: ProductFacts, groups: readonly PriceGroup[] = []): object[] {
  return [buildServiceJsonLd(p, f, groups), buildFaqJsonLd(p.faqs), buildBreadcrumbJsonLd(productCrumbs(p))]
}

export interface ArticleInput { slug: string; h1: string; description: string; updated: string }

/** Article for a guide; dateModified is the guide's `updated` date. */
export function buildArticleJsonLd(g: ArticleInput): object {
  const url = absoluteUrl(`/guides/${g.slug}`)
  return {
    "@context": CONTEXT,
    "@type": "Article",
    headline: g.h1,
    description: g.description,
    url,
    mainEntityOfPage: url,
    dateModified: g.updated,
    author: DATAGOD_ORGANIZATION,
    publisher: DATAGOD_ORGANIZATION,
  }
}

// ── Landing pages (lib/seo/landing-pages.ts) ──────────────────────────

/** Home -> Services -> [parent product page] -> landing page. */
export function landingCrumbs(e: Pick<LandingEntry, "name" | "path">, parent?: Pick<ProductEntry, "name" | "path">): Crumb[] {
  return [
    { name: "Home", path: "/" },
    { name: "Services", path: "/services" },
    ...(parent ? [{ name: parent.name, path: parent.path }] : []),
    { name: e.name, path: e.path },
  ]
}

/** FAQPage and BreadcrumbList, from what the page shows. Prices are on the linked product pages' Service AggregateOffer. */
export function buildLandingJsonLd(e: Pick<LandingEntry, "faqs">, crumbs: readonly Crumb[]): object[] {
  return [buildFaqJsonLd(e.faqs), buildBreadcrumbJsonLd(crumbs)]
}
