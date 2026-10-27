import { productPageMetadata, renderProductPage } from "@/components/seo/product-page"

export const generateMetadata = () => productPageMetadata("mtn-data")

export default function Page() {
  return renderProductPage("mtn-data")
}
