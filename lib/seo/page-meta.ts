/**
 * Pure helpers for public product pages: Next.js metadata and live-fact
 * filtering (which related products / billers may be shown). No I/O.
 */
import type { Metadata } from "next"
import { absoluteUrl } from "./site"
import { PRODUCTS, getProduct, type ProductEntry, type ProductKey } from "./products"
import type { LiveFacts } from "./live-facts"

export const OG_IMAGE = "/og-image.png"

/** "missing" means the page must 404 (product dark or its facts unavailable). */
export function pageAvailability(key: ProductKey, facts: LiveFacts): "ok" | "missing" {
  return facts.products[key]?.available ? "ok" : "missing"
}

export function buildProductMetadata(p: ProductEntry): Metadata {
  const url = absoluteUrl(p.path)
  return {
    title: p.title,
    description: p.description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      siteName: "DATAGOD",
      url,
      title: p.title,
      description: p.description,
      images: [OG_IMAGE],
    },
    // Next replaces `twitter` only when the child sets it; without this the
    // root layout's "Instant mobile data..." copy would be inherited.
    twitter: { card: "summary_large_image", title: p.title, description: p.description, images: [OG_IMAGE] },
  }
}

/** Registry entries for `keys` that are live right now, in the given order. */
export function availableEntries(keys: readonly ProductKey[], facts: LiveFacts): ProductEntry[] {
  return keys.filter((k) => facts.products[k]?.available === true).map(getProduct)
}

/** Biller pages (registry order) whose biller is switched on. */
export function liveBillerEntries(facts: LiveFacts): ProductEntry[] {
  return PRODUCTS.filter((p) => p.biller !== undefined && facts.products[p.key]?.available === true)
}
