import { productPageMetadata, renderProductPage } from "@/components/seo/product-page"

export const generateMetadata = () => productPageMetadata("telecel-data")

export default function Page() {
  return renderProductPage("telecel-data")
}
