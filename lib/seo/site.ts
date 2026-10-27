import { headers } from "next/headers"
import { notFound } from "next/navigation"

export const SITE_URL = "https://www.datagod.store"

export function absoluteUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`
  return p === "/" ? SITE_URL : `${SITE_URL}${p}`
}

function defaultRootDomain(): string {
  return (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "datagod.store").toLowerCase()
}

/**
 * True when the request host is the DATAGOD marketing site (root, www, local
 * dev, preview deployments). False for shop subdomains, reserved app/admin/api
 * subdomains, custom domains, and empty hosts.
 */
export function isMainSiteHost(host: string | null, rootDomain: string = defaultRootDomain()): boolean {
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

/** Server-only: 404 when the request is on a custom domain / shop host. */
export async function assertMainSite(): Promise<void> {
  const h = await headers()
  if (h.get("x-domain-site-name")) notFound()
}
