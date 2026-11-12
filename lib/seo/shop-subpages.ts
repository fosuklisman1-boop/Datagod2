import type { Metadata } from "next"

/**
 * Checkout, order-status and confirmation pages under a storefront: never
 * indexed, links still followed, and no inherited shop-root canonical (the
 * shop layout's canonical points at the storefront home, which these pages
 * are not).
 */
export const TRANSACTIONAL_SHOP_METADATA: Metadata = {
  robots: { index: false, follow: true },
  alternates: { canonical: null },
}
