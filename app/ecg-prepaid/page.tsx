import { productPageMetadata, renderProductPage } from "@/components/seo/product-page"

export const generateMetadata = () => productPageMetadata("ecg-prepaid")

export default function Page() {
  return renderProductPage("ecg-prepaid")
}
