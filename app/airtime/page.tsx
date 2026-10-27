import { productPageMetadata, renderProductPage } from "@/components/seo/product-page"

export const generateMetadata = () => productPageMetadata("airtime")

export default function Page() {
  return renderProductPage("airtime")
}
