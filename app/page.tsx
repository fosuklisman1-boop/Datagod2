import type { Metadata } from "next"
import HomeClient from "./home-client"
import { SITE_URL, isMainSiteRequest } from "@/lib/seo/site"
import { getLiveFacts } from "@/lib/seo/live-facts"
import { homeServiceLinks } from "@/lib/seo/home-links"

// The home page UI is a client component (app/home-client.tsx); this server
// wrapper declares the route's canonical and works out which service cards
// can link to a product page on this host.
export const metadata: Metadata = {
  alternates: { canonical: SITE_URL },
}

export default async function HomePage() {
  const serviceLinks = (await isMainSiteRequest()) ? homeServiceLinks(await getLiveFacts(), true) : {}
  return <HomeClient serviceLinks={serviceLinks} />
}
