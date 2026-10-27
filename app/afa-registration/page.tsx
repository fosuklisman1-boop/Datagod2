import { productPageMetadata, renderProductPage } from "@/components/seo/product-page"

export const generateMetadata = () => productPageMetadata("afa-registration")

export default function Page() {
  return renderProductPage("afa-registration")
}
