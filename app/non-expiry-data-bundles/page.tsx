import { landingPageMetadata, renderLandingPage } from "@/components/seo/landing-page"
import { getStandardNoExpiry } from "@/lib/seo/standard-bundles-facts"

export const generateMetadata = () => landingPageMetadata("non-expiry-data-bundles")

export default function Page() {
  return renderLandingPage("non-expiry-data-bundles", { standardNoExpiry: getStandardNoExpiry })
}
