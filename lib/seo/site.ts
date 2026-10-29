import { headers } from "next/headers"
import { notFound } from "next/navigation"

export const SITE_URL = "https://www.datagod.store"

export function absoluteUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`
  return p === "/" ? SITE_URL : `${SITE_URL}${p}`
}

// Lives in a client-safe module (this file imports next/headers) so client
// components can use it too; re-exported here for existing server importers.
export { isMainSiteHost } from "./main-site-host"

/**
 * Server-only: false on a custom domain / shop host (middleware sets
 * x-domain-site-name there). For pages that also serve those hosts and must
 * leave out Datagod-only extras (JSON-LD, links to main-site product pages).
 */
export async function isMainSiteRequest(): Promise<boolean> {
  const h = await headers()
  return !h.get("x-domain-site-name")
}

/** Server-only: 404 when the request is on a custom domain / shop host. */
export async function assertMainSite(): Promise<void> {
  if (!(await isMainSiteRequest())) notFound()
}
