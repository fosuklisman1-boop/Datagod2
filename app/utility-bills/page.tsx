import { productPageMetadata, renderProductPage } from "@/components/seo/product-page"

export const generateMetadata = () => productPageMetadata("utility-bills")

export default function Page() {
  return renderProductPage("utility-bills")
}
