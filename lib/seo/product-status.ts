/**
 * Status gate for registry product pages, run by the root layout (H3).
 *
 * app/loading.tsx puts every page behind a Suspense boundary, so Next sends a
 * 200 shell before a page or its (streamed) metadata runs; an error thrown
 * there can only show the error boundary. The root layout renders inside the
 * shell, so an error thrown here fails the shell and Next answers 500 — the
 * status we want when a product's live facts could not be read (crawlers
 * retry a 5xx later; they would drop a 404 and index an error page served
 * with 200). Dynamic responses are not cached, and getLiveFacts() never
 * caches a partial read, so the 500 lasts only as long as the outage.
 *
 * Off products ("off") and pages that are not template product pages pass.
 * Landing pages (lib/seo/landing-pages.ts) follow the same rule.
 */
import { headers } from "next/headers"
import { findProductByPath } from "./products"
import { getLiveFacts, LiveFactsUnavailableError } from "./live-facts"
import { pageAvailability } from "./page-meta"
import { findLandingByPath, landingAvailability } from "./landing-pages"
import { REQUEST_PATH_HEADER, SITE_KIND_HEADER, isMainSiteFromHeaders } from "./site-kind"

export async function assertProductFactsLoaded(): Promise<void> {
  const h = await headers()
  const path = h.get(REQUEST_PATH_HEADER)
  const p = findProductByPath(path)
  const landing = p ? undefined : findLandingByPath(path)
  // Only the registry template pages (components/seo/product-page.tsx) and the
  // landing pages (components/seo/landing-page.tsx); the hand-built pages
  // (join, bulk-sms, ...) never 404 or 5xx on live facts.
  if (!landing && (!p || !p.hasOwnPage)) return
  // Product and landing pages 404 off the main host anyway.
  if (!isMainSiteFromHeaders({ siteKind: h.get(SITE_KIND_HEADER), host: h.get("host"), domainSiteName: h.get("x-domain-site-name") })) return
  const facts = await getLiveFacts()
  if (landing) {
    if (landingAvailability(landing, facts) === "failed") throw new LiveFactsUnavailableError(landing.key, facts.failedSources)
    return
  }
  if (p && pageAvailability(p.key, facts) === "failed") throw new LiveFactsUnavailableError(p.key, facts.failedSources)
}
