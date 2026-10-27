import { productPageMetadata, renderProductPage } from "@/components/seo/product-page"

export const generateMetadata = () => productPageMetadata("telecel-broadband")

export default function Page() {
  return renderProductPage("telecel-broadband")
}
