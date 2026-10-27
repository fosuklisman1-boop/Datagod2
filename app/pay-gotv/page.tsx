import { productPageMetadata, renderProductPage } from "@/components/seo/product-page"

export const generateMetadata = () => productPageMetadata("pay-gotv")

export default function Page() {
  return renderProductPage("pay-gotv")
}
