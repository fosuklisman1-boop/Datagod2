import { landingPageMetadata, renderLandingPage } from "@/components/seo/landing-page"

export const generateMetadata = () => landingPageMetadata("at-ishare-data")

export default function Page() {
  return renderLandingPage("at-ishare-data")
}
