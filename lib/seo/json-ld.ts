/**
 * JSON-LD for public product pages: Service (+ Offer when a live "from" price
 * is known), FAQPage and BreadcrumbList. Pure.
 *
 * Never emits ratings or reviews: DATAGOD has no verified review data, and
 * fabricated AggregateRating markup is a Google structured-data violation.
 */
import { absoluteUrl, SITE_URL } from "./site"
import type { Faq, ProductEntry } from "./products"
import type { ProductFacts } from "./live-facts"

const CONTEXT = "https://schema.org"

/** Schema.org Offer price: 2 decimals from GH₵1 up, 3 below (0.025 -> "0.025"). */
export function offerPrice(n: number): string {
  return n < 1 ? n.toFixed(3) : n.toFixed(2)
}

export const DATAGOD_ORGANIZATION = {
  "@type": "Organization",
  name: "DATAGOD",
  url: SITE_URL,
  logo: absoluteUrl("/favicon-v2.jpeg"),
} as const

export function buildServiceJsonLd(p: ProductEntry, f: ProductFacts): object {
  const url = absoluteUrl(p.path)
  const hasPrice = typeof f.fromPrice === "number" && Number.isFinite(f.fromPrice) && f.fromPrice > 0
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

export function buildProductJsonLd(p: ProductEntry, f: ProductFacts): object[] {
  return [buildServiceJsonLd(p, f), buildFaqJsonLd(p.faqs), buildBreadcrumbJsonLd(productCrumbs(p))]
}
