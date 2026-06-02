"use client"

import { useEffect, useState } from "react"

// Root domain the app runs under (e.g. "datagod.store"). Mirrors NEXT_PUBLIC_ROOT_DOMAIN
// used by middleware. Subdomains of this are shop storefronts.
const ROOT_DOMAIN = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "datagod.store").toLowerCase()

// Hosts/labels that are never a shop subdomain (kept in sync with middleware).
const RESERVED_SUBDOMAINS = new Set(["www", "app", "admin", "api"])

// True when `hostname` is a shop storefront subdomain (e.g. "my-shop.datagod.store"
// or "my-shop.localhost"). Used to decide whether storefront links need the
// /shop/<slug> path prefix (main host) or can be root-relative (subdomain host).
function isShopSubdomainHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  let label: string | null = null
  if (h.endsWith(".localhost")) {
    label = h.slice(0, -".localhost".length)
  } else if (h.endsWith(`.${ROOT_DOMAIN}`)) {
    label = h.slice(0, -(`.${ROOT_DOMAIN}`.length))
  }
  if (!label || label.includes(".")) return false
  return !RESERVED_SUBDOMAINS.has(label)
}

// Returns the base path for storefront links given the current host:
//   - on a shop subdomain  → ""            (links are root-relative: `/checkout`)
//   - on the main host     → "/shop/<slug>" (legacy path: `/shop/<slug>/checkout`)
//
// Use as: const base = useShopBasePath(slug); router.push(`${base}/checkout`).
// Returns the path form during SSR / first paint, then corrects on the client — safe
// because middleware routes both forms to the same page; only the visible URL differs.
export function useShopBasePath(slug: string): string {
  const [base, setBase] = useState(`/shop/${slug}`)
  useEffect(() => {
    if (typeof window !== "undefined" && isShopSubdomainHost(window.location.hostname)) {
      setBase("")
    } else {
      setBase(`/shop/${slug}`)
    }
  }, [slug])
  return base
}

// Builds the canonical external storefront URL for a shop, e.g.
// "https://my-shop.datagod.store". Use for share links, sitemap, and metadata.
export function shopOrigin(subdomain: string): string {
  return `https://${subdomain}.${ROOT_DOMAIN}`
}
