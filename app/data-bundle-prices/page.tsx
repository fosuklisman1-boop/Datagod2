import { landingPageMetadata, renderLandingPage } from "@/components/seo/landing-page"

export const generateMetadata = () => landingPageMetadata("data-bundle-prices")

export default function Page() {
  return renderLandingPage("data-bundle-prices")
}
