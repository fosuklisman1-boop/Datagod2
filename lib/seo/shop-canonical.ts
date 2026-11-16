import { headers } from "next/headers"
import { resolveCustomDomain } from "@/lib/custom-domain-lookup"
import { normalizeDomainHost, type CustomDomainConfig } from "@/lib/custom-domains"
import { SITE_KIND_HEADER, parseSiteKind, type SiteKind } from "./site-kind"

// Mirrors the ROOT_DOMAIN used by middleware.ts and app/sitemap.ts.
const ROOT_DOMAIN = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "datagod.store").toLowerCase()

/**
 * The storefront's canonical origin (no trailing slash): the shop's subdomain
 * under the custom domain it is being served on, else under the root domain.
 * Shops that predate the subdomain backfill fall back to the /shop/<slug> path
 * on www, same as app/sitemap.ts, so canonical and sitemap never disagree.
 */
export function shopCanonicalBase(
  shop: { subdomain: string | null; shop_slug: string },
  customDomain: string | null | undefined,
  rootDomain: string = ROOT_DOMAIN,
): string {
  return shop.subdomain
    ? `https://${shop.subdomain}.${customDomain || rootDomain}`
    : `https://www.${rootDomain}/shop/${shop.shop_slug}`
}

/** Canonical URL of a storefront subpage, e.g. shopCanonicalUrl(base, "/afa"). */
export function shopCanonicalUrl(base: string, subpath: string = ""): string {
  if (!subpath || subpath === "/") return base
  return `${base}${subpath.startsWith("/") ? subpath : `/${subpath}`}`
}

/**
 * Server-only: the custom-domain config for THIS request's host (null on the
 * root domain and its subdomains) and the middleware's site kind. Resolved by
 * the actual request host, not shop.linked_custom_domain: that field only
 * covers a domain linked directly to one shop, not a wildcard-mode domain.
 */
export async function shopRequestContext(): Promise<{ domainConfig: CustomDomainConfig | null; siteKind: SiteKind | null }> {
  const h = await headers()
  const requestHost = normalizeDomainHost(h.get("host"))
  const domainConfig = requestHost ? await resolveCustomDomain(requestHost).catch(() => null) : null
  return { domainConfig, siteKind: parseSiteKind(h.get(SITE_KIND_HEADER)) }
}
