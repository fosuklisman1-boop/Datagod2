// Client-safe (no server imports): the storefront uses this from the browser.

/**
 * Absolute join-page URL, always on the main domain so it works from subdomain and custom-domain storefronts
 * (the join page and its confirmation email link live on the main site).
 */
export function joinShopUrl(handle: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://datagod.store").replace(/\/+$/, "")
  return `${base}/join/shop/${encodeURIComponent(handle)}`
}

/**
 * The short link owners share: https://subagents.<root>/<handle>. The middleware redirects it to
 * joinShopUrl's page (see lib/sub-agents/join-host.ts). Literal "subagents" here because this file
 * must stay client-safe; keep it in step with SUBAGENTS_SUBDOMAIN.
 */
export function shareJoinUrl(handle: string): string {
  const root = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "datagod.store").toLowerCase()
  return `https://subagents.${root}/${encodeURIComponent(handle)}`
}
