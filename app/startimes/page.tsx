import { productPageMetadata, renderProductPage } from "@/components/seo/product-page"

export const generateMetadata = () => productPageMetadata("startimes")

export default function Page() {
  return renderProductPage("startimes")
}
