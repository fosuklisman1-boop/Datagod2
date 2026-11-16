/**
 * Root (homepage / site-wide default) metadata copy for the main DATAGOD site,
 * and search-console verification tags. Pure; app/layout.tsx uses it.
 * Copy rules match lib/seo/products.ts (enforced by root-meta.test.ts).
 */
import type { Metadata } from "next"

export const ROOT_TITLE = "Buy Cheap MTN, Telecel & AT Data Bundles in Ghana | DATAGOD"
export const ROOT_DESCRIPTION =
  "Buy cheap MTN, Telecel and AT data bundles in Ghana. Fund your DATAGOD wallet with MoMo, then buy data and airtime. Usually delivered within minutes."
export const ROOT_LOCALE = "en_GH"
export const HTML_LANG = "en-GH"

/**
 * Google / Bing site-verification meta tags from GOOGLE_SITE_VERIFICATION and
 * BING_SITE_VERIFICATION. Each is included only when set (non-blank);
 * undefined when neither is.
 */
export function siteVerification(env: Record<string, string | undefined> = process.env): Metadata["verification"] {
  const google = env.GOOGLE_SITE_VERIFICATION?.trim()
  const bing = env.BING_SITE_VERIFICATION?.trim()
  if (!google && !bing) return undefined
  return {
    ...(google && { google }),
    ...(bing && { other: { "msvalidate.01": bing } }),
  }
}
