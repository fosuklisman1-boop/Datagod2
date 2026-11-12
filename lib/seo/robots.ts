/**
 * robots.txt content, pure so it can be tested. app/robots.ts passes the
 * request host.
 */
import type { MetadataRoute } from "next"
import { SITE_URL } from "./site"

const BLOCKED_SUBDOMAINS = ["app", "admin", "api"] as const

function defaultRootDomain(): string {
  return (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "datagod.store").toLowerCase()
}

/** True for app./admin./api.<root>: hosts with nothing to index (they duplicate or serve the app/API). */
export function isBlockedRobotsHost(host: string | null | undefined, rootDomain: string = defaultRootDomain()): boolean {
  const h = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "")
  return BLOCKED_SUBDOMAINS.some((sub) => h === `${sub}.${rootDomain.toLowerCase()}`)
}

export function buildRobots(host: string | null | undefined, rootDomain?: string): MetadataRoute.Robots {
  if (isBlockedRobotsHost(host, rootDomain)) {
    return { rules: [{ userAgent: "*", disallow: "/" }] }
  }

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Admin/dashboard/api are auth-gated with no indexable content. The
        // /auth/* functional routes (OAuth callback, email confirm, password
        // reset, profile completion, mobile handoff) carry one-time tokens in
        // their query strings and have no SEO value — crawling them serves no
        // purpose and could touch a live token. /auth/login, /auth/signup and
        // /auth/forgot-password are deliberately left crawlable (see their
        // layout.tsx) so Google can see their `noindex` meta tag rather than
        // just blindly listing an un-crawled URL.
        disallow: [
          "/admin",
          "/admin-setup",
          "/api",
          "/dashboard",
          "/auth/callback",
          "/auth/confirm",
          "/auth/reset-password",
          "/auth/complete-profile",
          "/auth/mobile-handoff",
        ],
      },
      {
        userAgent: "AdsBot-Google",
        allow: "/",
      },
    ],
    // Always the canonical host, whatever NEXT_PUBLIC_APP_URL says.
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
