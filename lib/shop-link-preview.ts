// Link-preview (Open Graph / Twitter card) content for a shop's storefront.
// Kept separate from app/shop/[slug]/layout.tsx so it can be unit-tested
// without Next's server-only header/request plumbing.

const PLATFORM_OG_IMAGE = "https://www.datagod.store/og-image.png"

type PreviewShop = {
  shop_name: string
  description?: string | null
  logo_url?: string | null
  banner_url?: string | null
}

export type ShopPreviewImage = {
  url: string
  // Only set for images whose size we actually know. A shop logo can be any
  // size or shape, and declaring a fake 1200x630 makes some clients crop it.
  width?: number
  height?: number
  // Logos are usually square, so they read best as a thumbnail ("summary")
  // card; a banner or the platform image fills a wide "summary_large_image".
  card: "summary" | "summary_large_image"
}

// The shop's own description wins; whitespace-only counts as unset, so a shop
// that cleared the field doesn't preview with a blank description.
export function shopPreviewDescription(shop: PreviewShop, fallback: string): string {
  const own = shop.description?.trim()
  return own || fallback
}

// Browser-tab / home-screen icon for a storefront: the shop's own logo, so a
// shop's subdomain isn't branded with the DATAGOD favicon. A custom domain's
// admin-set logo still wins on that domain (the root layout already applies
// it), so this returns null there and when the shop has no logo — callers then
// leave the inherited icons alone.
export function shopIconUrl(shop: PreviewShop, customDomainLogo?: string | null): string | null {
  if (customDomainLogo?.trim()) return null
  return shop.logo_url?.trim() || null
}

// Logo first: it's the shop's identity and what owners expect to see when
// they share their link. Banner, then the platform image, are fallbacks for
// shops that haven't uploaded a logo.
export function shopPreviewImage(shop: PreviewShop): ShopPreviewImage {
  const logo = shop.logo_url?.trim()
  if (logo) return { url: logo, card: "summary" }

  const banner = shop.banner_url?.trim()
  if (banner) return { url: banner, card: "summary_large_image" }

  return { url: PLATFORM_OG_IMAGE, width: 1200, height: 630, card: "summary_large_image" }
}
