import { sanitizeShopHandle } from "@/lib/shop-handle"

/** The subdomain owners share for sub-agent sign-ups: https://subagents.<root>/<shop-handle>. */
export const SUBAGENTS_SUBDOMAIN = "subagents"

/**
 * Host routing for the short sign-up link. subagents.<root>/<handle> redirects to the join page on the
 * main site (sessions, Turnstile and the email confirmation all live there). Pure so the middleware
 * stays a short call. Returns the absolute redirect target, or null when the request isn't for the
 * subagents host (and for static files on it, which the main app serves normally).
 */
export function subagentsHostRedirect(host: string | null | undefined, path: string, rootDomain: string): string | null {
  const root = rootDomain.toLowerCase()
  const hostname = (host ?? "").split(":")[0].toLowerCase()
  if (hostname !== `${SUBAGENTS_SUBDOMAIN}.${root}`) return null
  if (/\.[^/]+$/.test(path)) return null

  const origin = `https://www.${root}`
  // No shop in the address (or not a shop-shaped one): the "this is a sub-agent sign-up address" page.
  const landing = `${origin}/join/shop`
  const segments = path.split("/").filter(Boolean)
  if (segments.length !== 1) return landing

  let raw = segments[0]
  try {
    raw = decodeURIComponent(raw)
  } catch {
    // Malformed escapes: sanitize the raw text instead.
  }
  const handle = sanitizeShopHandle(raw)
  return handle ? `${origin}/join/shop/${handle}` : landing
}
