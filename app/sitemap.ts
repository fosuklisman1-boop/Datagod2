import type { MetadataRoute } from "next"
import { headers } from "next/headers"
import { isMainSiteHost } from "@/lib/seo/site"
import { getLiveFacts } from "@/lib/seo/live-facts"
import { buildSitemapEntries } from "@/lib/seo/discovery"

// Reads request headers (host guard), so this is dynamic; live facts are
// cached for an hour inside getLiveFacts().
export const revalidate = 3600

// Registry-driven: only products that are live right now. Shop storefronts are
// deliberately NOT listed. /auth/* and /dashboard are excluded too (noindex or
// auth-gated and disallowed in robots.ts).
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const host = (await headers()).get("host")
  if (!isMainSiteHost(host)) return []
  return buildSitemapEntries(await getLiveFacts(), new Date())
}
