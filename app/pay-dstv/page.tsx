import { productPageMetadata, renderProductPage } from "@/components/seo/product-page"

export const generateMetadata = () => productPageMetadata("pay-dstv")

export default function Page() {
  return renderProductPage("pay-dstv")
}
