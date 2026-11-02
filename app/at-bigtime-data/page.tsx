import { landingPageMetadata, renderLandingPage } from "@/components/seo/landing-page"

export const generateMetadata = () => landingPageMetadata("at-bigtime-data")

export default function Page() {
  return renderLandingPage("at-bigtime-data")
}
