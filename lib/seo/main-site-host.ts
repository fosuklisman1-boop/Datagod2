// Client-safe (no next/headers import): used by both server routes (via
// lib/seo/site.ts) and client components such as FirstTouchCapture.
import { isMainSiteFromHeaders } from "./site-kind"

/**
 * True when the request is on the DATAGOD marketing site (root, www, local
 * dev, preview deployments). False for shop subdomains, reserved
 * app/admin/api subdomains, custom domains, and empty hosts.
 *
 * `siteKind` is the x-site-kind header middleware set for this request; when
 * it is present it decides. Without it this falls back to the host check
 * (lib/seo/site-kind.ts isMainHostName).
 */
export function isMainSiteHost(host: string | null, rootDomain?: string, siteKind?: string | null): boolean {
  return isMainSiteFromHeaders({ siteKind, host }, rootDomain)
}
