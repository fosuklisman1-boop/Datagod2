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

/** First custom keyword or built-in phishing rule the message trips, or null.
 *  The exact matching filterSmsContent uses; shared with the send policy. */
export function matchBlockedContent(message: string, blockedKeywords: string[] = []): string | null {
  const plain = message.toLowerCase()
  const normalized = normalizeCopy(message)
  for (const kw of blockedKeywords) {
    if (!kw || !kw.trim()) continue
    if (plain.includes(kw.toLowerCase()) || normalized.includes(normalizeCopy(kw))) {
      return `blocked keyword: "${kw}"`
    }
  }
  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(plain) || rule.pattern.test(normalized)) return rule.reason
  }
  return null
}

/** Why a link host is suspicious (shortener / digit-letter lookalike), or null. */
export function suspiciousHostReason(host: string): string | null {
  const h = host.toLowerCase().replace(/^www\./, "")
  if (SHORTENER_HOSTS.has(h)) return "suspicious link: known shortener"
  if (isHomoglyphHost(h)) return "suspicious link: homoglyph domain"
  return null
}

// TLDs recognised for scheme-less links ("kings.shop/abc"). Kept to common ones so
// ordinary text ("Mr.Smith", "10.50") is never mistaken for a link.
const BARE_LINK_TLDS = "com|net|org|store|shop|app|io|co|gh|xyz|info|biz|me|link|site|online|top|click|live|ly|to|gl|gd|gy"
const BARE_LINK_RE = new RegExp(
  `(?<![@\\w.-])(?:www\\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${BARE_LINK_TLDS}))(?=$|[\\/\\s:?#.,!)'"])`,
  "gi"
)

/** Every link host in the message — http(s) URLs, www hosts and bare domains on common
 *  TLDs — lowercased, without a leading "www.", de-duplicated, in order of appearance. */
export function extractLinkHosts(message: string): string[] {
  const out: string[] = []
  const add = (h: string) => {
    const host = h.toLowerCase().replace(/^www\./, "")
    if (!out.includes(host)) out.push(host)
  }
  const withoutSchemes = message.replace(/https?:\/\/([^/\s?#]+)/gi, (_m, host: string) => {
    add(host)
    return " "
  })
  for (const m of withoutSchemes.matchAll(BARE_LINK_RE)) add(m[1])
  return out
}

export function filterSmsContent(message: string, options: FilterOptions = {}): FilterResult {
  const { blockedKeywords = [], allowedDomains = [] } = options

  const blockedReason = matchBlockedContent(message, blockedKeywords)
  if (blockedReason) return { blocked: true, flagged: false, reason: blockedReason }

  for (const host of extractHosts(message)) {
    const suspicious = suspiciousHostReason(host)
    if (suspicious) return { blocked: true, flagged: false, reason: suspicious }
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
