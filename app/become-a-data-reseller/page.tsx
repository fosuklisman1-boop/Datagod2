import { landingPageMetadata, renderLandingPage } from "@/components/seo/landing-page"

export const generateMetadata = () => landingPageMetadata("become-a-data-reseller")

export default function Page() {
  return renderLandingPage("become-a-data-reseller")
}
