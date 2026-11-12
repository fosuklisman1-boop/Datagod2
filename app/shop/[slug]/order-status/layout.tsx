import { TRANSACTIONAL_SHOP_METADATA } from "@/lib/seo/shop-subpages"

// Transactional storefront page: noindex, follow, no shop-root canonical.
export const metadata = TRANSACTIONAL_SHOP_METADATA

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
