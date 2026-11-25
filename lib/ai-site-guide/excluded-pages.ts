/** Routes deliberately left out of the site guide, each with the reason. */
export interface ExcludedPage {
  path: string
  reason: string
}

const SEO = "Marketing landing page generated from the product registry; it duplicates a product the guide already covers."

export const EXCLUDED_PAGES: ExcludedPage[] = [
  { path: "/afa-registration", reason: SEO },
  { path: "/airtime", reason: SEO },
  { path: "/at-bigtime-data", reason: SEO },
  { path: "/at-data", reason: SEO },
  { path: "/at-ishare-data", reason: SEO },
  { path: "/become-a-data-reseller", reason: SEO },
  { path: "/cheapest-data-ghana", reason: SEO },
  { path: "/ecg-prepaid", reason: SEO },
  { path: "/ghana-water", reason: SEO },
  { path: "/mtn-data", reason: SEO },
  { path: "/non-expiry-data-bundles", reason: SEO },
  { path: "/pay-dstv", reason: SEO },
  { path: "/pay-gotv", reason: SEO },
  { path: "/startimes", reason: SEO },
  { path: "/telecel-broadband", reason: SEO },
  { path: "/telecel-data", reason: SEO },
  { path: "/ussd", reason: SEO },
  { path: "/utility-bills", reason: SEO },
  { path: "/guides", reason: "Search-engine guides hub generated from a registry; articles cover the same how-tos." },
  { path: "/guides/:slug", reason: "Search-engine how-to article generated from a registry; no action to perform." },
  { path: "/privacy", reason: "Legal page; read-only text with nothing to do." },
  { path: "/terms", reason: "Legal page; read-only text with nothing to do." },
  { path: "/admin-setup", reason: "One-time internal admin bootstrap page; never described to customers." },
  { path: "/auth/mobile-handoff", reason: "Automatic sign-in hand-off from the mobile app; no user action." },
  { path: "/dashboard/unavailable", reason: "Error-style notice shown when a domain has no pages enabled; no action." },
  { path: "/join/shop", reason: "Placeholder telling people to open a shop's own sign-up link; the real page is covered." },
  { path: "/shop/:slug/afa/confirmation", reason: "Post-payment status screen reached automatically; not a page people use to start anything." },
  { path: "/shop/:slug/airtime/confirmation", reason: "Post-payment status screen reached automatically; not a page people use to start anything." },
  { path: "/shop/:slug/order-confirmation/:orderId", reason: "Post-payment receipt screen reached automatically; order-status covers checking an order." },
  { path: "/shop/:slug/payment-confirmation", reason: "Post-payment status screen reached automatically; not a page people use to start anything." },
  { path: "/shop/:slug/results-check/confirmation", reason: "Post-payment status screen reached automatically; not a page people use to start anything." },
  { path: "/shop/:slug/results-checker/confirmation", reason: "Post-payment status screen reached automatically; not a page people use to start anything." },
]
