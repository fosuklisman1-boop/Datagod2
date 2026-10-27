import { productPageMetadata, renderProductPage } from "@/components/seo/product-page"

export const generateMetadata = () => productPageMetadata("ghana-water")

export default function Page() {
  return renderProductPage("ghana-water")
}
