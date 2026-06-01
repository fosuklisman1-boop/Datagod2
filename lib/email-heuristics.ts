// Lightweight bot-email heuristics. These catch obvious scripted-signup garbage
// (repeated-character local parts, known throwaway domains) with near-zero false
// positives. NOT a substitute for Cloudflare / Turnstile — just a cheap speed bump
// that rejects the current flood wave before any DB work.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

// Known disposable / throwaway / attacker-observed domains. Add as patterns emerge.
const SUSPICIOUS_DOMAINS = new Set<string>([
  "mli.mc",
  "ouhh.com",
  "jjjoi.com",
  "eenail.com",   // typo-squat of gmail/email
  "email.com",    // often used by bots filling "email" literally
  "test.com",
  "example.com",
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "throwawaymail.com",
])

export interface EmailCheck {
  ok: boolean
  reason?: string
}

/**
 * Returns ok:false for emails that are structurally invalid OR match a strong
 * bot signature. Designed to NOT reject any plausible real customer email.
 */
export function checkEmailQuality(rawEmail: unknown): EmailCheck {
  if (!rawEmail || typeof rawEmail !== "string") return { ok: false, reason: "missing" }
  const email = rawEmail.trim().toLowerCase()

  // 1) Format
  if (!EMAIL_RE.test(email)) return { ok: false, reason: "format" }

  const atIdx = email.lastIndexOf("@")
  const local = email.slice(0, atIdx)
  const domain = email.slice(atIdx + 1)

  // 2) Repeated-character local part — e.g. kkkkkkk, gggggg, aaaa.
  //    Same single character 4+ times with nothing else = bot. Real emails don't do this.
  if (/^(.)\1{3,}$/.test(local)) return { ok: false, reason: "repeated_char_local" }

  // 3) Local part that is a single character repeated as the WHOLE string
  //    (covers kkkkkkk where length varies). Already covered above, kept for clarity.

  // 4) Known throwaway / suspicious domain
  if (SUSPICIOUS_DOMAINS.has(domain)) return { ok: false, reason: "disposable_domain" }

  // 5) Domain whose label before the TLD is a single repeated char (e.g. kkk.com)
  const domainParts = domain.split(".")
  const sld = domainParts.length >= 2 ? domainParts[domainParts.length - 2] : ""
  if (sld && /^(.)\1{2,}$/.test(sld)) return { ok: false, reason: "repeated_char_domain" }

  return { ok: true }
}
