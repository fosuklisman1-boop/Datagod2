export interface FilterResult {
  blocked: boolean
  flagged: boolean
  reason?: string
}

export interface FilterOptions {
  blockedKeywords?: string[]
  allowedDomains?: string[]
}

// Known URL shorteners that must be blocked
const SHORTENER_HOSTS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "buff.ly",
  "adf.ly", "shorte.st", "is.gd", "rebrand.ly", "rb.gy",
])

// Phishing / credential harvest / prize / reversal patterns (applied post-normalization)
const BLOCK_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bpin\b/,            reason: "credential-harvest: pin" },
  { pattern: /\bpassword\b/,       reason: "credential-harvest: password" },
  { pattern: /\botp\b.*send|send.*\botp\b/, reason: "credential-harvest: otp" },
  { pattern: /you\s*have\s*won/,   reason: "prize/lottery" },
  { pattern: /\blottery\b/,        reason: "prize/lottery" },
  { pattern: /\bprize\b/,          reason: "prize/lottery" },
  { pattern: /account.*reversed|reversed.*account/, reason: "fake-reversal" },
  { pattern: /\bverify.*account\b|\baccount.*verify\b/, reason: "phishing: account-verify" },
]

// Greek/Cyrillic → Latin homoglyph map (visual confusables)
const HOMOGLYPHS: Record<string, string> = {
  "ρ": "p",  // ρ → p
  "р": "p",  // р (Cyrillic) → p
  "а": "a",  // а (Cyrillic) → a
  "е": "e",  // е (Cyrillic) → e
  "ε": "e",  // ε (Greek) → e
  "ο": "o",  // ο (Greek) → o
  "о": "o",  // о (Cyrillic) → o
  "і": "i",  // і (Cyrillic) → i
  "ι": "i",  // ι (Greek) → i
  "с": "c",  // с (Cyrillic) → c
  "ѕ": "s",  // ѕ (Cyrillic) → s
  "у": "y",  // у (Cyrillic) → y
  "х": "x",  // х (Cyrillic) → x
}

// GSM-7 leet digit → letter (only applied when surrounded by or adjacent to letters,
// avoiding turning product codes like "5GB" into "sGB")
const LEET_MAP: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t",
}

/** Strip zero-width chars, normalize diacritics, de-confuse homoglyphs, apply leet
 *  (letter-context only), collapse repeats, de-separate 'p.i.n' / 'p.1n' → 'pin'. */
function normalizeCopy(text: string): string {
  let s = text
  // 1. Remove zero-width and invisible Unicode characters
  s = s.replace(/[​-‏‪-‮⁠-⁤﻿­]/g, "")
  // 2. NFD decompose then strip combining diacritics (e.g. î → i)
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, "")
  // 3. Homoglyph substitution
  s = [...s].map((ch) => HOMOGLYPHS[ch] ?? ch).join("")
  // 4. Lowercase
  s = s.toLowerCase()
  // 5. Strip separator chars (. _ -) between word characters — catches p.i.n, p.1n, a-b-c evasion
  s = s.replace(/(?<=\w)[._-](?=\w)/g, "")
  // 6. De-leet: digit replaced only when between two letters (word-interior context)
  s = s.replace(/(?<=[a-z])[01345](?=[a-z])/g, (d) => LEET_MAP[d] ?? d)
  // Also replace leading digit if followed by letters (e.g. '1' in '1nfo')
  s = s.replace(/\b[01345](?=[a-z]{2})/g, (d) => LEET_MAP[d] ?? d)
  // 7. Collapse runs of 3+ identical letters → 2 (piiiiin → piin; further collapse below)
  s = s.replace(/([a-z])\1{2,}/g, "$1$1")
  // 8. Collapse runs of 2+ identical letters → 1 (piin → pin)
  s = s.replace(/([a-z])\1+/g, "$1")
  return s
}

/** Extract all HTTP/HTTPS hosts from message text. */
function extractHosts(text: string): string[] {
  const matches = [...text.matchAll(/https?:\/\/([^/\s?#]+)/gi)]
  return matches.map((m) => m[1].toLowerCase())
}

/** Returns true if a hostname looks like a homoglyph attack on a common trusted domain
 *  (e.g. paypa1.com, g00gle.com). Simple digit-substitution detection. */
function isHomoglyphHost(host: string): boolean {
  // Strip TLD and check if the base domain contains digit-for-letter substitution patterns
  const base = host.replace(/\.[a-z]{2,}$/, "")
  return /[0-9]/.test(base) && /[a-z]/.test(base)
}

export function filterSmsContent(message: string, options: FilterOptions = {}): FilterResult {
  const plain = message.toLowerCase()
  const normalized = normalizeCopy(message)
  const { blockedKeywords = [], allowedDomains = [] } = options

  // --- Custom blocked keywords (first-block-wins) ---
  for (const kw of blockedKeywords) {
    const kwNorm = normalizeCopy(kw)
    if (plain.includes(kw.toLowerCase()) || normalized.includes(kwNorm)) {
      return { blocked: true, flagged: false, reason: `blocked keyword: "${kw}"` }
    }
  }

  // --- Built-in block rules (applied to both copies) ---
  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(plain) || rule.pattern.test(normalized)) {
      return { blocked: true, flagged: false, reason: rule.reason }
    }
  }

  // --- Link analysis ---
  const hosts = extractHosts(message)
  for (const host of hosts) {
    // Block known shorteners
    if (SHORTENER_HOSTS.has(host)) {
      return { blocked: true, flagged: false, reason: "suspicious link: known shortener" }
    }
    // Block homoglyph domains
    if (isHomoglyphHost(host)) {
      return { blocked: true, flagged: false, reason: "suspicious link: homoglyph domain" }
    }
    // Flag non-allowed domains if an allowlist is provided
    if (allowedDomains.length > 0) {
      const allowed = allowedDomains.some(
        (d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`)
      )
      if (!allowed) {
        return { blocked: false, flagged: true, reason: `link to non-allowed domain: ${host}` }
      }
    }
  }

  return { blocked: false, flagged: false }
}
