import type { Metadata } from "next"
import HomeClient from "./home-client"
import { SITE_URL, isMainSiteRequest } from "@/lib/seo/site"
import { getLiveFacts } from "@/lib/seo/live-facts"
import { homeDataNetworkLinks, homeFooterLinks, homePopularPackages, homeServiceLinks } from "@/lib/seo/home-links"

// The home page UI is a client component (app/home-client.tsx); this server
// wrapper declares the route's canonical, works out which service cards can
// link to a product page on this host, and loads the "Popular Data Packages"
// tiles from the cached public price tables (packages.price) so they are in
// the server HTML rather than fetched after hydration.
export const metadata: Metadata = {
  alternates: { canonical: SITE_URL },
}

export default async function HomePage() {
  const [mainSite, facts] = await Promise.all([isMainSiteRequest(), getLiveFacts()])
  return (
    <HomeClient
      serviceLinks={homeServiceLinks(facts, mainSite)}
      dataNetworkLinks={homeDataNetworkLinks(facts, mainSite)}
      footerLinks={homeFooterLinks(facts, mainSite)}
      popularPackages={homePopularPackages(facts, mainSite)}
    />
  )
}
