import { ghanaSignificant } from "@/lib/phone-format"

/**
 * Normalize a shop owner's free-text WhatsApp contact field into a safe,
 * absolute URL.
 *
 * Owners often type a bare phone number or a malformed scheme (confirmed in
 * production: "0598781315", "https.wa.me 0249489229", "https//wa.me+233...",
 * "Wa.me/+233..."). Rendered directly as an <a href>, any value without a
 * real "https://" scheme gets resolved by the browser as a RELATIVE path
 * under the current storefront's URL (/shop/[slug]/...) — which Next.js then
 * treats as a request for a *different* shop, by that text as the slug, and
 * fails with "shop not found". This affected roughly half of all shops'
 * WhatsApp links in production.
 */
export function normalizeWhatsAppLink(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Already a well-formed absolute URL — leave it alone.
  if (/^https?:\/\//i.test(trimmed)) return trimmed

  // Recognizably a WhatsApp domain with a missing/broken scheme.
  const domainMatch = trimmed.match(/(wa\.me|wa\.link|chat\.whatsapp\.com|api\.whatsapp\.com)[\s/]*(.*)$/i)
  if (domainMatch) {
    const [, domain, rawRest] = domainMatch
    const rest = rawRest.replace(/^\/+/, "")
    // If what follows the domain is just a bare Ghana number (e.g. someone
    // pasted "wa.me 0249489229"), convert it to the international format
    // wa.me actually requires — otherwise leave the path as typed, since it
    // may be a message/QR shortlink code, not a number.
    const restAsPhone = rest ? ghanaSignificant(rest) : null
    const cleanRest = restAsPhone ? `233${restAsPhone}` : rest
    return `https://${domain.toLowerCase()}${cleanRest ? "/" + cleanRest : ""}`
  }

  // A bare Ghana phone number in any accepted format.
  const significant = ghanaSignificant(trimmed)
  if (significant) return `https://wa.me/233${significant}`

  // Last resort: at minimum give it a scheme so it's never treated as a
  // relative path under the current shop's URL.
  return `https://${trimmed.replace(/^\/+/, "")}`
}
