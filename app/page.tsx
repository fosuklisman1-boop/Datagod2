import type { Metadata } from "next"
import HomeClient from "./home-client"
import { SITE_URL } from "@/lib/seo/site"

// The home page UI is a client component (app/home-client.tsx); this server
// wrapper exists so the route can declare its own canonical.
export const metadata: Metadata = {
  alternates: { canonical: SITE_URL },
}

export default function HomePage() {
  return <HomeClient />
}
