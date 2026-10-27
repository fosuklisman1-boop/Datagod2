import { productPageMetadata, renderProductPage } from "@/components/seo/product-page"

export const generateMetadata = () => productPageMetadata("ussd")

export default function Page() {
  return renderProductPage("ussd")
}
