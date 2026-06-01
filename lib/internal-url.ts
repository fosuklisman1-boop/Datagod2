// Base URL for server-to-server calls to our own API (e.g. webhook → fulfillment).
//
// PROBLEM: once the site is behind Cloudflare, calling the PUBLIC domain from a
// serverless function has no browser fingerprint, so Cloudflare Bot Fight Mode
// challenges it and returns an HTML challenge page → JSON.parse crash →
// fulfillment of PAID orders silently fails.
//
// FIX OPTIONS (either works; the Cloudflare rule is the cleaner one):
//   (A) Add a Cloudflare WAF rule: Skip bot challenges for URI Path starts-with
//       "/api/". API endpoints have their own auth (internal secret / JWT /
//       cookie) so they never need Cloudflare's bot challenge. Recommended.
//   (B) Set INTERNAL_BASE_URL to the Vercel origin (e.g.
//       https://<project>.vercel.app) so internal calls route around Cloudflare.
//
// This helper prefers INTERNAL_BASE_URL when set, else the public domain
// (which then relies on option A).
export function getInternalBaseUrl(): string {
  if (process.env.INTERNAL_BASE_URL) return process.env.INTERNAL_BASE_URL.replace(/\/$/, "")
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return "http://localhost:3000"
}
