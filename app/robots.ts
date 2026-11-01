import type { MetadataRoute } from "next"
import { headers } from "next/headers"
import { buildRobots } from "@/lib/seo/robots"

// Reads the Host header (middleware runs for /robots.txt), so this is served
// per request: app./admin./api. get "Disallow: /", every other host the
// normal rules with the canonical www sitemap.
export default async function robots(): Promise<MetadataRoute.Robots> {
  return buildRobots((await headers()).get("host"))
}
