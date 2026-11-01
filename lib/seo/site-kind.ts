/**
 * Which kind of host a request is on, decided once in middleware.ts and passed
 * to server components in the x-site-kind request header. Pure (no Next
 * imports) so the edge middleware can use it.
 *
 *  - "main":   the canonical DATAGOD marketing site (root, www, localhost,
 *              Vercel preview URLs).
 *  - "shop":   a reseller storefront subdomain (<shop>.datagod.store, or
 *              <shop>.localhost in dev).
 *  - "custom": every other host: an admin-configured custom domain (in account
 *              or shop mode), the reserved app./admin./api. subdomains, and
 *              unmapped foreign hosts. None of them is the canonical site, so
 *              none of them gets main-site-only SEO extras.
 */
export type SiteKind = "main" | "shop" | "custom"

export const SITE_KIND_HEADER = "x-site-kind"

const KINDS: readonly SiteKind[] = ["main", "shop", "custom"]

/** The header value as a SiteKind, or null when absent / not one of the three. */
export function parseSiteKind(value: string | null | undefined): SiteKind | null {
  const v = value?.trim().toLowerCase()
  return v && (KINDS as readonly string[]).includes(v) ? (v as SiteKind) : null
}

function defaultRootDomain(): string {
  return (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "datagod.store").toLowerCase()
}

/**
 * Host-only check: true for the DATAGOD marketing site (root, www, local dev,
 * preview deployments). False for shop subdomains, reserved app/admin/api
 * subdomains, custom domains, and empty hosts.
 */
export function isMainHostName(host: string | null | undefined, rootDomain: string = defaultRootDomain()): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase().replace(/:\d+$/, "")
  if (!h) return false

  if (h === "localhost" || h === "127.0.0.1") return true
  if (h.endsWith(".vercel.app")) return true

  const root = rootDomain.toLowerCase()
  if (h === root || h === `www.${root}`) return true

  // Anything else (shop subdomain, app./admin./api., foreign custom domain)
  return false
}

/**
 * Middleware's classification. `shopSubdomain` / `customDomain` are what the
 * middleware already resolved for this host; a custom domain wins over
 * everything (including wildcard shop labels under it).
 */
export function classifySiteKind(
  host: string | null | undefined,
  resolved: { shopSubdomain: string | null; customDomain: boolean },
  rootDomain: string = defaultRootDomain(),
): SiteKind {
  if (resolved.customDomain) return "custom"
  if (resolved.shopSubdomain) return "shop"
  return isMainHostName(host, rootDomain) ? "main" : "custom"
}

/**
 * Main-site decision from request headers: the middleware's x-site-kind when
 * present; otherwise (a request middleware did not handle) the old checks —
 * the host must be a main host and no custom-domain branding may be set.
 */
export function isMainSiteFromHeaders(
  h: { siteKind: string | null | undefined; host: string | null | undefined; domainSiteName?: string | null },
  rootDomain: string = defaultRootDomain(),
): boolean {
  const kind = parseSiteKind(h.siteKind)
  if (kind) return kind === "main"
  return !h.domainSiteName && isMainHostName(h.host, rootDomain)
}

/**
 * The request pathname as middleware saw it (before any shop rewrite). The
 * root layout reads it to know which product page it is wrapping; layouts
 * get no pathname from Next.
 */
export const REQUEST_PATH_HEADER = "x-request-path"
