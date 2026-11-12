import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { SITE_KIND_HEADER, isMainHostName, isMainSiteFromHeaders } from "./site-kind"

export const SITE_URL = "https://www.datagod.store"

export function absoluteUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`
  return p === "/" ? SITE_URL : `${SITE_URL}${p}`
}

// Lives in a client-safe module (this file imports next/headers) so client
// components can use it too; re-exported here for existing server importers.
export { isMainSiteHost } from "./main-site-host"

/**
 * Server-only: true only on the main DATAGOD host. Reads middleware's
 * x-site-kind header (main | shop | custom); falls back to the Host header
 * plus x-domain-site-name when middleware did not handle the request. For
 * pages that also serve shop / custom hosts and must leave out Datagod-only
 * extras (JSON-LD, links to main-site product pages).
 */
export async function isMainSiteRequest(): Promise<boolean> {
  const h = await headers()
  return isMainSiteFromHeaders({
    siteKind: h.get(SITE_KIND_HEADER),
    host: h.get("host"),
    domainSiteName: h.get("x-domain-site-name"),
  })
}

/** Server-only: 404 when the request is not on the main host. */
export async function assertMainSite(): Promise<void> {
  if (!(await isMainSiteRequest())) notFound()
}

export { isMainHostName }
