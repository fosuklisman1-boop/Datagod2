// Browser-safe: no node imports. The admin's contact is stored as digits only and the
// wa.me link is always built here, so the field can never send a user to another site.
import { ghanaSignificant } from "@/lib/phone-format"

type ParseResult = { ok: true; digits: string | null } | { ok: false; error: string }

const PLAIN = /^\+?[\d\s\-().]+$/
const HELP =
  "Paste a WhatsApp number (for example 0559919037 or +233 55 991 9037), a link like https://wa.me/233559919037, or leave it empty to use the support number."

const bad = (error: string): ParseResult => ({ ok: false, error })

/**
 * Digits -> canonical international digits, or null. `international` is true when the input
 * carried a "+" or came from a link: a non-233 country code is then kept as-is (never fed to
 * ghanaSignificant, which strips non-digits and would misread it as a Ghana number).
 */
function normalise(digits: string, hasPlus: boolean, international: boolean): string | null {
  if (!digits) return null
  if (digits.startsWith("233")) {
    const sig = ghanaSignificant(digits)
    return sig ? "233" + sig : null
  }
  if (digits.startsWith("0")) {
    if (hasPlus) return null
    const sig = ghanaSignificant(digits)
    return sig ? "233" + sig : null
  }
  if (international) return /^\d{8,15}$/.test(digits) ? digits : null
  const sig = ghanaSignificant(digits)
  return sig ? "233" + sig : null
}

function fromPhoneText(raw: string, international: boolean): string | null {
  const t = raw.trim()
  if (!PLAIN.test(t)) return null
  if (t.indexOf("+") > 0) return null
  const hasPlus = t.startsWith("+")
  return normalise(t.replace(/\D/g, ""), hasPlus, international || hasPlus)
}

function fromLink(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null
  if (u.hostname === "wa.me") {
    const m = /^\/(\+?\d+)\/?$/.exec(u.pathname)
    return m ? fromPhoneText(m[1], true) : null
  }
  if (u.hostname === "api.whatsapp.com") {
    if (u.pathname !== "/send") return null
    const phone = u.searchParams.get("phone") // a literal "+" decodes to a space; trimmed by fromPhoneText
    return phone ? fromPhoneText(phone, true) : null
  }
  return null
}

export function parseApprovalContact(input: unknown): ParseResult {
  if (input === null || input === undefined) return { ok: true, digits: null }
  if (typeof input !== "string") return bad(HELP)
  const t = input.trim()
  if (!t) return { ok: true, digits: null }
  const digits = PLAIN.test(t) ? fromPhoneText(t, false) : fromLink(t)
  if (!digits) {
    return bad(
      /wa\.me\/message|chat\.whatsapp\.com/i.test(t)
        ? "That link cannot carry a pre-filled message. " + HELP
        : "That is not a valid WhatsApp number or link. " + HELP,
    )
  }
  return { ok: true, digits }
}

/** Configured value (already normalised) wins; else the support number, which has lost any "+". */
export function resolveContact(configured: string | null, support: string | null): string | null {
  if (configured && /^\d{8,15}$/.test(configured) && !configured.startsWith("0")) return configured
  if (!support || !/^\d+$/.test(support)) return null
  if (support.startsWith("233") || support.startsWith("0")) {
    const sig = ghanaSignificant(support)
    return sig ? "233" + sig : null
  }
  const sig = ghanaSignificant(support)
  if (sig && support.length === 9) return "233" + sig
  return /^\d{10,15}$/.test(support) ? support : null
}

export function buildApprovalLink(digits: string, p: { code: string; email: string | null }): string {
  if (!/^\d{8,15}$/.test(digits)) throw new Error("buildApprovalLink: digits must be 8-15 digits")
  const email = p.email?.trim()
  const text =
    `Hello, I've requested Datagod API approval. Code: ${p.code}.` + (email ? ` Account: ${email}.` : "")
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
}
