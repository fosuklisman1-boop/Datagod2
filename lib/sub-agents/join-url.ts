// Client-safe (no server imports): the storefront uses this from the browser.

/**
 * Absolute join-page URL, always on the main domain so it works from subdomain and custom-domain storefronts
 * (the join page and its confirmation email link live on the main site).
 */
export function joinShopUrl(handle: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://datagod.store").replace(/\/+$/, "")
  return `${base}/join/shop/${encodeURIComponent(handle)}`
}
