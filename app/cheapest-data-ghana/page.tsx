import { productPageMetadata, renderProductPage } from "@/components/seo/product-page"

export const generateMetadata = () => productPageMetadata("cheapest-data")

export default function Page() {
  return renderProductPage("cheapest-data")
}
