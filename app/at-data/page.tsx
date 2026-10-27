import { productPageMetadata, renderProductPage } from "@/components/seo/product-page"

export const generateMetadata = () => productPageMetadata("at-data")

export default function Page() {
  return renderProductPage("at-data")
}
