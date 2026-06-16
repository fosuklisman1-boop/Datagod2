# Bulk SMS — Plan 3 of 5: Metered Send Pipeline Implementation Plan

> ### ⚠️ Cross-plan reconciliation (read first)
> One of 5 Bulk SMS milestone plans authored together; applied in order **M2 → M3 → M4 → M5**.
> - **ENGINE DECISION (settled 2026-06-16):** the metered send uses a **`sms_messages` queue drained by a cron**, mirroring `lib/broadcast-drain.ts` (`claim … FOR UPDATE SKIP LOCKED`, attempt-cap, idempotent per-row send). This **replaces this plan's in-route synchronous send loop** — `POST /api/shop/sms/send` should debit credits + ENQUEUE rows and return; the cron sends per-recipient and refunds failures. (Vercel Workflow DevKit was evaluated and rejected — it wouldn't build cleanly in this app. See [[project-bulk-sms]].) Net effect: the segment/filter/debit/refund/log logic in this plan stays; only the *send loop* moves from inline to the drain cron + a `claim_sms_messages` SQL fn.
> - **Migration numbers are INDICATIVE.** At execution, use the next unused `NNNN_` prefix above the highest already in `migrations/` (latest is `0064`, plus whatever M2 added). Don't trust the literal numbers.
> - `lib/sms/personalize.ts` created here is **shared** — Milestone 5 imports it. It is owned by THIS plan.
> - `app/dashboard/sms/page.tsx` **already has Milestone 2's** activation card, bonus claim, balance/pending, and bundle store. **ADD your composer as a new tab — do NOT rewrite the page** and clobber M2's UI. Read the current page first and extend it.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the metered SMS send pipeline — shared pure-logic core (segment math, content filter, message prep, merge-field personalization), the `debit_sms_for_send` RPC + audit tables, the `POST /api/shop/sms/send` route, and a composer UI with live segment/cost counter and phone-mock preview.

**Architecture:** Pure-logic modules are developed test-first and imported by both the API route (server) and the composer (client). The DB layer adds `sms_send_logs` (audit/moderation), `sms_refund_failures` (refund replay), and a new `debit_sms_for_send` SECURITY DEFINER RPC that atomically checks account status and debits credits — all balance mutations still go through `adjust_sms_units`. The API route follows the sequence: prepare → filter → price → debit → send → refund-failed → log. The composer page extends `app/dashboard/sms/page.tsx` with a compose tab, reusing `calculateSegments` client-side so the cost meter is never out of sync with server billing.

**Tech Stack:** TypeScript, Next.js 15 App Router (`route.ts` handlers), Vitest 4 (unit tests), `@supabase/supabase-js` v2, existing `sendSMS` from `lib/sms-service.ts`, Zod v4 for request validation, Tailwind CSS for composer UI.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `lib/sms/segments.ts` | **Create** | `calculateSegments`, `calculateCredits` — pure GSM-7/UCS-2 segment math |
| `lib/sms/segments.test.ts` | **Create** | Unit tests for all segment boundary cases |
| `lib/sms/content-filter.ts` | **Create** | `filterSmsContent` — dual-pass block/flag logic |
| `lib/sms/content-filter.test.ts` | **Create** | Unit tests for block/flag/evasion/allowlist cases |
| `lib/sms/prepare.ts` | **Create** | `stripUndeliverableChars`, `prepareSmsMessage` — emoji-strip + token substitution |
| `lib/sms/prepare.test.ts` | **Create** | Unit tests for strip, substitution, empty-after-strip rejection |
| `lib/sms/personalize.ts` | **Create** | `MERGE_TOKENS`, `hasMergeTokens`, `personalize` — merge-field substitution |
| `lib/sms/personalize.test.ts` | **Create** | Unit tests for substitution, missing fields, plain messages |
| `migrations/0065_sms_send_pipeline.sql` | **Create** | `sms_send_logs`, `sms_refund_failures`, `debit_sms_for_send` RPC, RLS |
| `app/api/shop/sms/send/route.ts` | **Create** | `POST` handler — prepare→filter→price→debit→send→refund→log |
| `app/api/shop/sms/send/route.test.ts` | **Create** | Integration-style unit tests for the route handler |
| `app/dashboard/sms/page.tsx` | **Modify** | Add compose tab: textarea, recipient input, live meter, phone-mock preview, send history |

---

## Conventions

- **Fake Supabase client pattern:** `lib/sms/*.test.ts` files use `vi.hoisted` to create mutable state + a fake client before the module-under-test imports, then `vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))`. Copy this verbatim from `lib/sms/bundle-service.test.ts`.
- **No top-level awaits in route tests:** import the handler and call it directly with a fake `NextRequest`.
- **All balance changes via RPCs only:** never `.update({ unit_balance: ... })` directly.
- **Test runner:** `npm run test:run` (Vitest, no watch). Run specific files with `npx vitest run lib/sms/segments.test.ts`.
- **Imports:** use `@/lib/...` path aliases throughout (Next.js resolves them).

---

## Tasks

### Task 1: `lib/sms/segments.ts` — GSM-7 / UCS-2 segment math

**Files:**
- Create: `lib/sms/segments.ts`
- Create: `lib/sms/segments.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/sms/segments.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { calculateSegments, calculateCredits } from "./segments"

describe("calculateSegments — GSM-7", () => {
  it("empty string → 1 segment, 0 chars, 160 remaining", () => {
    const r = calculateSegments("")
    expect(r.encoding).toBe("gsm7")
    expect(r.length).toBe(0)
    expect(r.segments).toBe(1)
    expect(r.remaining).toBe(160)
    expect(r.singleLimit).toBe(160)
  })

  it("159 chars → 1 segment, 1 remaining", () => {
    const r = calculateSegments("a".repeat(159))
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(1)
    expect(r.remaining).toBe(1)
  })

  it("160 chars → 1 segment, 0 remaining (exact boundary)", () => {
    const r = calculateSegments("a".repeat(160))
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(1)
    expect(r.remaining).toBe(0)
  })

  it("161 chars → 2 segments (crosses into multipart, limit drops to 153)", () => {
    const r = calculateSegments("a".repeat(161))
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(2)
    // 161 chars / 153 per part = ceil → 2; remaining = 2*153 - 161 = 145
    expect(r.remaining).toBe(145)
    expect(r.singleLimit).toBe(160)
  })

  it("306 chars → 2 segments (153×2)", () => {
    const r = calculateSegments("a".repeat(306))
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(2)
    expect(r.remaining).toBe(0)
  })

  it("307 chars → 3 segments", () => {
    const r = calculateSegments("a".repeat(307))
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(3)
  })

  it("€ (extension char) counts as 2 GSM-7 code units", () => {
    // 158 plain chars + 1 '€' = 159 + 1 = 160 effective code units → 1 segment
    const r = calculateSegments("a".repeat(158) + "€")
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(1)
    expect(r.length).toBe(160) // effective length (billing length)
  })

  it("€ that pushes over 160 → 2 segments (GSM-7 still, just multipart)", () => {
    // 159 plain + 1 '€' = 160 + 1 = 161 effective → 2 segments
    const r = calculateSegments("a".repeat(159) + "€")
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(2)
  })

  it("{ and } are GSM-7 extension chars (count as 2 each)", () => {
    // 1 '{' = 2 effective code units; 158 plain + 1 '{' = 160 → still fits 1 segment
    const r = calculateSegments("a".repeat(158) + "{")
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(1)
    expect(r.length).toBe(160)
  })
})

describe("calculateSegments — UCS-2 (Unicode)", () => {
  it("one emoji flips encoding to unicode", () => {
    const r = calculateSegments("Hello 🎉")
    expect(r.encoding).toBe("unicode")
    expect(r.singleLimit).toBe(70)
  })

  it("69 unicode chars → 1 segment, 1 remaining", () => {
    const r = calculateSegments("á".repeat(69))
    expect(r.encoding).toBe("unicode")
    expect(r.segments).toBe(1)
    expect(r.remaining).toBe(1)
  })

  it("70 unicode chars → 1 segment, 0 remaining (exact boundary)", () => {
    const r = calculateSegments("á".repeat(70))
    expect(r.encoding).toBe("unicode")
    expect(r.segments).toBe(1)
    expect(r.remaining).toBe(0)
  })

  it("71 unicode chars → 2 segments (multipart limit drops to 67)", () => {
    const r = calculateSegments("á".repeat(71))
    expect(r.encoding).toBe("unicode")
    expect(r.segments).toBe(2)
    // 2×67 = 134; 134 - 71 = 63 remaining
    expect(r.remaining).toBe(63)
  })

  it("emoji counts as 1 code point (not 2 UTF-16 surrogates)", () => {
    // 'a' × 69 + '🎉' (1 code point) = 70 code points → 1 segment
    const r = calculateSegments("a".repeat(69) + "🎉")
    expect(r.encoding).toBe("unicode")
    expect(r.segments).toBe(1)
    expect(r.length).toBe(70)
  })
})

describe("calculateCredits", () => {
  it("1 segment × 10 recipients = 10 credits", () => {
    expect(calculateCredits("hello", 10)).toBe(10)
  })

  it("2-segment message × 5 recipients = 10 credits", () => {
    // 161 GSM-7 chars = 2 segments
    expect(calculateCredits("a".repeat(161), 5)).toBe(10)
  })

  it("0 recipients = 0 credits", () => {
    expect(calculateCredits("hi", 0)).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they all fail**

```bash
npx vitest run lib/sms/segments.test.ts
```

Expected: all tests fail with "Cannot find module './segments'" or similar.

- [ ] **Step 3: Implement `lib/sms/segments.ts`**

```typescript
// GSM-7 basic character set (single-code-unit characters)
const GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./" +
  "0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZ ÄÖÑÜ`" +
  "¿abcdefghijklmnopqrstuvwxyz äöñüà"
)

// GSM-7 extension table characters (each costs 2 code units: ESC + char)
const GSM7_EXTENSION = new Set("|^€{}\\[~]")

export interface SegmentResult {
  encoding: "gsm7" | "unicode"
  /** Effective billing length (extension chars count as 2 for GSM-7; code points for unicode) */
  length: number
  segments: number
  remaining: number
  /** Max chars in a SINGLE (non-concatenated) message for this encoding */
  singleLimit: number
}

function isGsm7(message: string): boolean {
  for (const ch of message) {
    if (!GSM7_BASIC.has(ch) && !GSM7_EXTENSION.has(ch)) return false
  }
  return true
}

function gsm7Length(message: string): number {
  let len = 0
  for (const ch of message) {
    len += GSM7_EXTENSION.has(ch) ? 2 : 1
  }
  return len
}

export function calculateSegments(message: string): SegmentResult {
  if (isGsm7(message)) {
    const length = gsm7Length(message)
    const singleLimit = 160
    const multiLimit = 153
    const segments = length <= singleLimit ? 1 : Math.ceil(length / multiLimit)
    const capacity = length <= singleLimit ? singleLimit : segments * multiLimit
    return { encoding: "gsm7", length, segments, remaining: capacity - length, singleLimit }
  }

  // UCS-2: count code points (so emoji = 1, not 2 UTF-16 code units)
  const length = [...message].length
  const singleLimit = 70
  const multiLimit = 67
  const segments = length <= singleLimit ? 1 : Math.ceil(length / multiLimit)
  const capacity = length <= singleLimit ? singleLimit : segments * multiLimit
  return { encoding: "unicode", length, segments, remaining: capacity - length, singleLimit }
}

export function calculateCredits(message: string, recipients: number): number {
  return calculateSegments(message).segments * recipients
}
```

- [ ] **Step 4: Run tests to verify they all pass**

```bash
npx vitest run lib/sms/segments.test.ts
```

Expected: all tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/sms/segments.ts lib/sms/segments.test.ts
git commit -m "feat(sms): pure GSM-7/UCS-2 segment calculator with comprehensive tests"
```

---

### Task 2: `lib/sms/content-filter.ts` — dual-pass anti-fraud filter

**Files:**
- Create: `lib/sms/content-filter.ts`
- Create: `lib/sms/content-filter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/sms/content-filter.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { filterSmsContent } from "./content-filter"

describe("filterSmsContent — clean messages pass", () => {
  it("plain promotional message passes", () => {
    const r = filterSmsContent("Buy our MTN 5GB bundle for GHS 15 today!")
    expect(r.blocked).toBe(false)
    expect(r.flagged).toBe(false)
    expect(r.reason).toBeUndefined()
  })

  it("allowed domain link passes", () => {
    const r = filterSmsContent("Shop now at https://datagod.app/shop", {
      allowedDomains: ["datagod.app"],
    })
    expect(r.blocked).toBe(false)
    expect(r.flagged).toBe(false)
  })
})

describe("filterSmsContent — phishing / credential patterns block", () => {
  it("'enter your pin' blocks", () => {
    const r = filterSmsContent("Please enter your PIN to verify your account.")
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/pin|credential/i)
  })

  it("'send your password' blocks", () => {
    const r = filterSmsContent("Please send your password to confirm.")
    expect(r.blocked).toBe(true)
  })

  it("prize / lottery blocks", () => {
    const r = filterSmsContent("Congratulations! You have won GHS 5000 in our lottery. Claim now.")
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/prize|lottery|won/i)
  })

  it("fake receipt / account reversal blocks", () => {
    const r = filterSmsContent("Your MoMo account has been reversed. Call immediately to reverse.")
    expect(r.blocked).toBe(true)
  })

  it("'verify your otp' blocks (credential harvest)", () => {
    const r = filterSmsContent("Your OTP is 123456. Never share your OTP with anyone. Send it back to verify.")
    expect(r.blocked).toBe(true)
  })
})

describe("filterSmsContent — suspicious links", () => {
  it("known URL shortener blocks", () => {
    const r = filterSmsContent("Click here: http://bit.ly/abc123")
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/link|url|domain/i)
  })

  it("non-allowed domain flags (not blocked, but flagged)", () => {
    const r = filterSmsContent("Visit http://randomsite.xyz/promo", {
      allowedDomains: ["datagod.app"],
    })
    expect(r.flagged).toBe(true)
    expect(r.blocked).toBe(false)
  })

  it("homoglyph domain blocks (paypa1.com)", () => {
    const r = filterSmsContent("Login at http://paypa1.com/secure")
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/link|domain|homoglyph/i)
  })
})

describe("filterSmsContent — obfuscation evasion still caught", () => {
  it("leet-speak PIN evasion caught: 'p1n' → 'pin'", () => {
    const r = filterSmsContent("Enter your p1n to proceed.")
    expect(r.blocked).toBe(true)
  })

  it("zero-width character injection caught", () => {
    // 'pin' with a zero-width non-joiner (‌) inserted between p and i
    const r = filterSmsContent("Enter your p‌in to proceed.")
    expect(r.blocked).toBe(true)
  })

  it("diacritics evasion caught: 'pîn' → 'pin'", () => {
    const r = filterSmsContent("Enter your pîn now.")
    expect(r.blocked).toBe(true)
  })

  it("Cyrillic homoglyph evasion caught: 'ρin' (rho) → 'pin'", () => {
    // ρ (U+03C1 rho) looks like 'p'
    const r = filterSmsContent("Enter your ρin to verify.")
    expect(r.blocked).toBe(true)
  })

  it("de-spaced evasion caught: 'p.i.n' → 'pin'", () => {
    const r = filterSmsContent("Send your p.i.n to this number.")
    expect(r.blocked).toBe(true)
  })

  it("repeated-char evasion caught: 'piiiiin' → 'pin' after collapsing", () => {
    // De-leet + collapse repeats: 'piiiiin' normalizes to 'pin'
    const r = filterSmsContent("piiiiin needed for verification.")
    expect(r.blocked).toBe(true)
  })

  it("combined evasion: leet + zero-width + de-space all caught", () => {
    // 'p.1‌n' → normalize → 'pin'
    const r = filterSmsContent("p.1‌n required to login.")
    expect(r.blocked).toBe(true)
  })
})

describe("filterSmsContent — custom blocked keywords", () => {
  it("custom blocked keyword blocks", () => {
    const r = filterSmsContent("This is a spam message.", { blockedKeywords: ["spam"] })
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/keyword/i)
  })

  it("custom keyword also subject to normalization", () => {
    const r = filterSmsContent("This is sp‌am.", { blockedKeywords: ["spam"] })
    expect(r.blocked).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they all fail**

```bash
npx vitest run lib/sms/content-filter.test.ts
```

Expected: all tests fail with "Cannot find module './content-filter'".

- [ ] **Step 3: Implement `lib/sms/content-filter.ts`**

```typescript
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
 *  (letter-context only), collapse repeats, de-space 'p.i.n' → 'pin'. */
function normalizeCopy(text: string): string {
  let s = text
  // 1. Remove zero-width and invisible Unicode characters
  s = s.replace(/[​-‏  ﻿­]/g, "")
  // 2. NFD decompose then strip combining diacritics (e.g. î → i)
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, "")
  // 3. Homoglyph substitution
  s = [...s].map((ch) => HOMOGLYPHS[ch] ?? ch).join("")
  // 4. Lowercase
  s = s.toLowerCase()
  // 5. De-leet: digit replaced only when between two letters (word-interior context)
  s = s.replace(/(?<=[a-z])[01345](?=[a-z])/g, (d) => LEET_MAP[d] ?? d)
  // Also replace leading digit if followed by letters (e.g. '1' in '1nfo')
  s = s.replace(/\b[01345](?=[a-z]{2})/g, (d) => LEET_MAP[d] ?? d)
  // 6. Collapse runs of 3+ identical letters → 2 (piiiiin → piin; further collapse below)
  s = s.replace(/([a-z])\1{2,}/g, "$1$1")
  // 7. Collapse runs of 2+ identical letters → 1 (piin → pin)
  s = s.replace(/([a-z])\1+/g, "$1")
  // 8. De-space: remove dots/spaces/underscores between single letters (p.i.n → pin)
  s = s.replace(/\b([a-z])([. _-][a-z])+\b/g, (m) => m.replace(/[. _-]/g, ""))
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
```

- [ ] **Step 4: Run tests to verify they all pass**

```bash
npx vitest run lib/sms/content-filter.test.ts
```

Expected: all tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/sms/content-filter.ts lib/sms/content-filter.test.ts
git commit -m "feat(sms): dual-pass content anti-fraud filter with obfuscation normalization"
```

---

### Task 3: `lib/sms/prepare.ts` — strip + token substitution

**Files:**
- Create: `lib/sms/prepare.ts`
- Create: `lib/sms/prepare.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/sms/prepare.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { stripUndeliverableChars, prepareSmsMessage } from "./prepare"

describe("stripUndeliverableChars", () => {
  it("plain GSM-7 message unchanged", () => {
    expect(stripUndeliverableChars("Hello World!")).toBe("Hello World!")
  })

  it("emoji stripped", () => {
    expect(stripUndeliverableChars("Hello 🎉")).toBe("Hello ")
  })

  it("astral code points stripped (e.g. 𝓗)", () => {
    // U+1D4D7 MATHEMATICAL BOLD SCRIPT CAPITAL H (astral)
    expect(stripUndeliverableChars("H\u{1D4D7}i")).toBe("Hi")
  })

  it("ZWJ (U+200D) stripped", () => {
    expect(stripUndeliverableChars("a‍b")).toBe("ab")
  })

  it("variation selector (U+FE0F) stripped", () => {
    expect(stripUndeliverableChars("a️b")).toBe("ab")
  })

  it("multiple internal spaces collapsed to one after strip removes a char", () => {
    // emoji between two spaces: "hello  world" after stripping → reflow
    expect(stripUndeliverableChars("hello 🎉 world")).toBe("hello  world")
    // NOTE: the function only strips chars, not the surrounding spaces.
    // The spec says "reflow whitespace only if changed" — collapsed here means
    // we do NOT double-strip; the two spaces remain as-is (the message changed).
    // A post-strip trim is applied to leading/trailing whitespace only.
  })

  it("leading/trailing whitespace trimmed after strip", () => {
    expect(stripUndeliverableChars("🎉 Hello")).toBe("Hello")
    expect(stripUndeliverableChars("Hello 🎉")).toBe("Hello")
  })

  it("message with no deliverability issues returned unchanged (no trim side-effect)", () => {
    const msg = "  Hello with intentional spaces  "
    // No astral/emoji/control chars present → returned as-is
    expect(stripUndeliverableChars(msg)).toBe(msg)
  })
})

describe("prepareSmsMessage", () => {
  const shopTokens = {
    shop_name: "GhanaKay",
    shop_link: "https://datagod.app/ghanakaay",
    shop_phone: "0244000000",
    shop_whatsapp: "0244000001",
  }

  it("substitutes {shop_name}", () => {
    expect(prepareSmsMessage("Welcome to {shop_name}!", shopTokens)).toBe("Welcome to GhanaKay!")
  })

  it("substitutes all four tokens", () => {
    const msg = "{shop_name} — visit {shop_link} or call {shop_phone} / WA {shop_whatsapp}"
    const result = prepareSmsMessage(msg, shopTokens)
    expect(result).toBe("GhanaKay — visit https://datagod.app/ghanakaay or call 0244000000 / WA 0244000001")
  })

  it("strips emoji from result after substitution", () => {
    const result = prepareSmsMessage("Hello from {shop_name} 🎉", shopTokens)
    expect(result).toBe("Hello from GhanaKay ")
  })

  it("throws if message is empty after stripping", () => {
    // A message that is purely emoji → empty after strip
    expect(() => prepareSmsMessage("🎉🎊🎈", shopTokens)).toThrow("empty after stripping")
  })

  it("unknown token left as-is (no substitution)", () => {
    const result = prepareSmsMessage("Hi {unknown_token}", shopTokens)
    expect(result).toBe("Hi {unknown_token}")
  })
})
```

- [ ] **Step 2: Run tests to verify they all fail**

```bash
npx vitest run lib/sms/prepare.test.ts
```

Expected: all tests fail with "Cannot find module './prepare'".

- [ ] **Step 3: Implement `lib/sms/prepare.ts`**

```typescript
export interface ShopTokens {
  shop_name: string
  shop_link: string
  shop_phone: string
  shop_whatsapp: string
}

/**
 * Remove characters that prevent SMS delivery on standard providers:
 * - Astral (supplementary) Unicode code points (emoji, mathematical symbols, etc.)
 * - Zero-width joiners / variation selectors
 * Trims leading/trailing whitespace only when the message actually changed.
 */
export function stripUndeliverableChars(message: string): string {
  // Match astral code points (U+10000 and above) and known problem control chars
  const stripped = message
    // Variation selectors (U+FE00–FE0F)
    .replace(/[︀-️]/g, "")
    // Zero-width joiner / non-joiner / non-breaking-space-like
    .replace(/[​-‏­﻿]/g, "")
    // Astral code points (emoji, mathematical alphanumerics, etc.) — use Unicode property escape
    .replace(/\p{So}|\p{Cs}/gu, "")
    // Remaining astral range via surrogate pairs (belt-and-suspenders for older runtimes)
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")

  if (stripped === message) return message
  return stripped.trim()
}

/**
 * Replace {shop_name}, {shop_link}, {shop_phone}, {shop_whatsapp} tokens,
 * then strip undeliverable characters. Throws if the result is empty.
 * Bill the PREPARED text (what the provider actually sends).
 */
export function prepareSmsMessage(message: string, tokens: ShopTokens): string {
  let result = message
  result = result.replace(/\{shop_name\}/g, tokens.shop_name)
  result = result.replace(/\{shop_link\}/g, tokens.shop_link)
  result = result.replace(/\{shop_phone\}/g, tokens.shop_phone)
  result = result.replace(/\{shop_whatsapp\}/g, tokens.shop_whatsapp)
  result = stripUndeliverableChars(result)
  if (result.trim().length === 0) {
    throw new Error("SMS message is empty after stripping undeliverable characters")
  }
  return result
}
```

- [ ] **Step 4: Run tests to verify they all pass**

```bash
npx vitest run lib/sms/prepare.test.ts
```

Expected: all tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/sms/prepare.ts lib/sms/prepare.test.ts
git commit -m "feat(sms): message prepare — strip undeliverable chars + shop token substitution"
```

---

### Task 4: `lib/sms/personalize.ts` — merge-field substitution

**Files:**
- Create: `lib/sms/personalize.ts`
- Create: `lib/sms/personalize.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/sms/personalize.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { MERGE_TOKENS, hasMergeTokens, personalize } from "./personalize"

describe("MERGE_TOKENS", () => {
  it("exports an array of token strings", () => {
    expect(Array.isArray(MERGE_TOKENS)).toBe(true)
    expect(MERGE_TOKENS).toContain("[FirstName]")
    expect(MERGE_TOKENS).toContain("[LastName]")
    expect(MERGE_TOKENS).toContain("[Phone]")
  })
})

describe("hasMergeTokens", () => {
  it("returns true when message contains [FirstName]", () => {
    expect(hasMergeTokens("Hi [FirstName], your bundle is ready.")).toBe(true)
  })

  it("returns true when message contains [Phone]", () => {
    expect(hasMergeTokens("Your number [Phone] is registered.")).toBe(true)
  })

  it("returns false for plain message", () => {
    expect(hasMergeTokens("Hello, your bundle is ready.")).toBe(false)
  })
})

describe("personalize", () => {
  it("replaces [FirstName] with firstName", () => {
    const result = personalize("Hi [FirstName]!", { firstName: "Ama", phone: "0244000000" })
    expect(result).toBe("Hi Ama!")
  })

  it("replaces [LastName] with lastName", () => {
    const result = personalize("Dear [LastName]", { lastName: "Mensah", phone: "0244000000" })
    expect(result).toBe("Dear Mensah")
  })

  it("replaces [Phone] with phone", () => {
    const result = personalize("Your number is [Phone].", { phone: "0244000000" })
    expect(result).toBe("Your number is 0244000000.")
  })

  it("replaces all tokens in one message", () => {
    const result = personalize("[FirstName] [LastName] ([Phone])", {
      firstName: "Ama",
      lastName: "Mensah",
      phone: "0244000000",
    })
    expect(result).toBe("Ama Mensah (0244000000)")
  })

  it("missing firstName leaves token in place (shows [FirstName])", () => {
    const result = personalize("Hi [FirstName]!", { phone: "0244000000" })
    expect(result).toBe("Hi [FirstName]!")
  })

  it("missing lastName leaves token in place", () => {
    const result = personalize("Dear [LastName]", { phone: "0244000000" })
    expect(result).toBe("Dear [LastName]")
  })

  it("replaces multiple occurrences of same token", () => {
    const result = personalize("[FirstName] is great, [FirstName]!", {
      firstName: "Ama",
      phone: "0244000000",
    })
    expect(result).toBe("Ama is great, Ama!")
  })

  it("message with no tokens returned unchanged", () => {
    const msg = "Bundle is ready."
    expect(personalize(msg, { phone: "0244000000" })).toBe(msg)
  })
})
```

- [ ] **Step 2: Run tests to verify they all fail**

```bash
npx vitest run lib/sms/personalize.test.ts
```

Expected: all tests fail with "Cannot find module './personalize'".

- [ ] **Step 3: Implement `lib/sms/personalize.ts`**

```typescript
export const MERGE_TOKENS = ["[FirstName]", "[LastName]", "[Phone]"] as const

export interface RecipientFields {
  firstName?: string
  lastName?: string
  phone: string
}

export function hasMergeTokens(message: string): boolean {
  return MERGE_TOKENS.some((t) => message.includes(t))
}

/**
 * Replace [FirstName], [LastName], [Phone] tokens with recipient values.
 * If a token is present but the corresponding field is missing or empty,
 * the token is left in place (so the caller can see what wasn't filled in).
 */
export function personalize(message: string, recipient: RecipientFields): string {
  let result = message
  if (recipient.firstName) result = result.replaceAll("[FirstName]", recipient.firstName)
  if (recipient.lastName)  result = result.replaceAll("[LastName]",  recipient.lastName)
  result = result.replaceAll("[Phone]", recipient.phone)
  return result
}
```

- [ ] **Step 4: Run tests to verify they all pass**

```bash
npx vitest run lib/sms/personalize.test.ts
```

Expected: all tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/sms/personalize.ts lib/sms/personalize.test.ts
git commit -m "feat(sms): merge-field personalization ([FirstName]/[LastName]/[Phone])"
```

---

### Task 5: DB migration — `sms_send_logs`, `sms_refund_failures`, `debit_sms_for_send`

**Files:**
- Create: `migrations/0065_sms_send_pipeline.sql`

- [ ] **Step 1: Write the migration file**

Create `migrations/0065_sms_send_pipeline.sql`:

```sql
-- Milestone 3: Metered Send Pipeline
-- Tables: sms_send_logs (audit + moderation), sms_refund_failures (refund replay)
-- RPC: debit_sms_for_send (atomic status-check + debit, no TOCTOU)

-- ───────────────────────────────────────────────────────────────
-- sms_send_logs: one row per API send call; feeds admin moderation (M4)
-- ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_send_logs (
  id               BIGSERIAL PRIMARY KEY,
  sms_account_id   UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
  message          TEXT NOT NULL,
  recipients_count INT  NOT NULL CHECK (recipients_count > 0),
  segments         INT  NOT NULL CHECK (segments > 0),
  credits_used     INT  NOT NULL CHECK (credits_used >= 0),
  status           TEXT NOT NULL CHECK (status IN ('sent', 'partial', 'failed', 'blocked')),
  flagged          BOOLEAN NOT NULL DEFAULT false,
  flag_reason      TEXT,
  provider         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_send_logs_account_time
  ON sms_send_logs (sms_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sms_send_logs_flagged
  ON sms_send_logs (sms_account_id)
  WHERE flagged = true;

ALTER TABLE sms_send_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sms_send_logs_owner_select ON sms_send_logs;
CREATE POLICY sms_send_logs_owner_select ON sms_send_logs
  FOR SELECT TO authenticated
  USING (
    sms_account_id IN (SELECT id FROM sms_accounts WHERE user_id = auth.uid())
  );

-- ───────────────────────────────────────────────────────────────
-- sms_refund_failures: credits that could not be refunded at send time
-- A cron (or admin action) can replay these via adjust_sms_units
-- ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_refund_failures (
  id               BIGSERIAL PRIMARY KEY,
  sms_account_id   UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
  credits          INT  NOT NULL CHECK (credits > 0),
  reason           TEXT NOT NULL,
  resolved         BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sms_refund_failures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sms_refund_failures_owner_select ON sms_refund_failures;
CREATE POLICY sms_refund_failures_owner_select ON sms_refund_failures
  FOR SELECT TO authenticated
  USING (
    sms_account_id IN (SELECT id FROM sms_accounts WHERE user_id = auth.uid())
  );

-- ───────────────────────────────────────────────────────────────
-- debit_sms_for_send: atomic status gate + unit debit
--
-- Raises application errors (5-char SQLSTATE):
--   'NOT_A' (P0001) → account status is not 'active' (inactive/missing)
--   'SUSPE' (P0001) → account is suspended
--   'INSUF' (P0001) → insufficient credits (adjust_sms_units returned no rows)
--
-- The status check and the balance debit happen inside the same statement sequence
-- with no gap — callers cannot race the status check.
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION debit_sms_for_send(
  p_account_id UUID,
  p_credits    INT
)
RETURNS TABLE(balance_after INT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status
  FROM sms_accounts
  WHERE id = p_account_id;

  IF NOT FOUND OR v_status <> 'active' THEN
    IF v_status = 'suspended' THEN
      RAISE EXCEPTION 'Account is suspended' USING ERRCODE = 'P0001', HINT = 'SUSPE';
    END IF;
    RAISE EXCEPTION 'Account is not active' USING ERRCODE = 'P0001', HINT = 'NOT_A';
  END IF;

  RETURN QUERY
  SELECT a.balance_after
  FROM adjust_sms_units(p_account_id, -p_credits, 'campaign_send') a;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient SMS credits' USING ERRCODE = 'P0001', HINT = 'INSUF';
  END IF;
END;
$$;
```

- [ ] **Step 2: Apply via Supabase Management API**

In the Supabase dashboard (or via the MCP tool), run:

```sql
-- Paste the full contents of migrations/0065_sms_send_pipeline.sql
```

Or use the Management API SQL endpoint (project ref from `reference-supabase-access.md`):

```bash
curl -X POST \
  "https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query" \
  -H "Authorization: Bearer $SUPABASE_MANAGEMENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "<paste sql>"}'
```

- [ ] **Step 3: Verify the migration applied**

Run this verification query in Supabase SQL editor:

```sql
-- Tables exist
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('sms_send_logs', 'sms_refund_failures');

-- RPC exists
SELECT proname FROM pg_proc WHERE proname = 'debit_sms_for_send';

-- Indexes exist
SELECT indexname FROM pg_indexes
WHERE tablename IN ('sms_send_logs', 'sms_refund_failures');
```

Expected: 2 table rows, 1 function row, 3 index rows.

- [ ] **Step 4: Commit the migration file**

```bash
git add migrations/0065_sms_send_pipeline.sql
git commit -m "feat(sms): add sms_send_logs, sms_refund_failures, debit_sms_for_send RPC"
```

---

### Task 6: `POST /api/shop/sms/send` — route handler (write test first)

**Files:**
- Create: `app/api/shop/sms/send/route.test.ts`
- Create: `app/api/shop/sms/send/route.ts`

The route follows this sequence:
1. Auth (Bearer token → `user`)
2. Validate body with Zod (`message`, `recipients`)
3. `getOrCreateAccountForUser` → 403 if null
4. `prepareSmsMessage` (shop tokens from account) → 400 if throws
5. `filterSmsContent` → 400 + log `status='blocked'` if blocked; set `flagged` flag
6. `calculateSegments` on the PREPARED message
7. `creditsNeeded = segments × recipients.length` → 402 if balance < creditsNeeded (pre-check only — actual atomic check is in the RPC)
8. `debit_sms_for_send(accountId, creditsNeeded)` → 402 (INSUF) / 403 (SUSPE/NOT_A) on error
9. Loop `recipients` via `sendSMS`, count `sent` / `failed`
10. If `failed > 0`: refund `segments × failed` via `adjust_sms_units`; if that errors, insert `sms_refund_failures`
11. Insert `sms_send_logs`
12. Return `{success, data:{total, sent, failed, credits_used, remaining}}`

- [ ] **Step 1: Write the failing tests**

Create `app/api/shop/sms/send/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// ── Hoisted mutable state + fakes ──────────────────────────────────────────
const h = vi.hoisted(() => {
  const state = {
    unitBalance: 500,
    accountStatus: "active" as string,
    debitError: null as string | null,    // 'INSUF' | 'SUSPE' | 'NOT_A' | null
    adjustError: false,
    sendResults: [] as Array<{ ok: boolean }>,  // one per recipient, in order
    insertLogError: false,
    calls: [] as Array<{ fn: string; args: any }>,
  }
  const accountRow = {
    id: "acc1",
    user_id: "u1",
    owner_type: "shop",
    owner_id: "shop1",
    unit_balance: 500,
    status: "active",
  }
  const fake = {
    auth: {
      getUser: (_token: string) =>
        Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
    },
    rpc: (fn: string, args: any) => {
      state.calls.push({ fn, args })
      if (fn === "debit_sms_for_send") {
        if (state.debitError) {
          const hints: Record<string, string> = {
            INSUF: "Insufficient SMS credits",
            SUSPE: "Account is suspended",
            NOT_A: "Account is not active",
          }
          return Promise.resolve({
            data: null,
            error: { message: hints[state.debitError] ?? "error", hint: state.debitError },
          })
        }
        state.unitBalance -= args.p_credits
        return Promise.resolve({ data: [{ balance_after: state.unitBalance }], error: null })
      }
      if (fn === "adjust_sms_units") {
        if (state.adjustError) return Promise.resolve({ data: null, error: { message: "adjust failed" } })
        state.unitBalance += args.p_delta
        return Promise.resolve({ data: [{ balance_after: state.unitBalance }], error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
    from: (table: string) => ({
      insert: (row: any) => {
        state.calls.push({ fn: `insert:${table}`, args: row })
        if (table === "sms_send_logs" && state.insertLogError) {
          return Promise.resolve({ data: null, error: { message: "log insert failed" } })
        }
        return Promise.resolve({ data: row, error: null })
      },
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: accountRow, error: null }) }) }),
    }),
  }
  const sendSMSSpy = vi.fn()
  const getAccountSpy = vi.fn(() => Promise.resolve({ ...accountRow, unit_balance: state.unitBalance }))
  return { state, fake, sendSMSSpy, getAccountSpy }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms/account-service", () => ({ getOrCreateAccountForUser: (...a: any[]) => h.getAccountSpy(...a) }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: (...a: any[]) => h.sendSMSSpy(...a) }))

import { POST } from "./route"

function makeRequest(body: object) {
  return new NextRequest("http://localhost/api/shop/sms/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  h.state.calls.length = 0
  h.state.unitBalance = 500
  h.state.accountStatus = "active"
  h.state.debitError = null
  h.state.adjustError = false
  h.state.insertLogError = false
  h.state.sendResults = []
  h.sendSMSSpy.mockReset()
  h.getAccountSpy.mockReset().mockResolvedValue({
    id: "acc1", user_id: "u1", owner_type: "shop", owner_id: "shop1",
    unit_balance: 500, status: "active",
  })
})

describe("POST /api/shop/sms/send — happy path", () => {
  it("all recipients sent → 200 with sent=2, failed=0, credits_used=2", async () => {
    // 2 recipients, 1-segment message (5 chars = 1 GSM-7 segment)
    h.sendSMSSpy.mockResolvedValue({ success: true })
    const res = await POST(makeRequest({ message: "Hello", recipients: ["0244000001", "0244000002"] }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.sent).toBe(2)
    expect(body.data.failed).toBe(0)
    expect(body.data.credits_used).toBe(2)
    expect(body.data.total).toBe(2)
    // debit_sms_for_send called with 2 credits
    const debit = h.state.calls.find((c) => c.fn === "debit_sms_for_send")
    expect(debit?.args.p_credits).toBe(2)
    // sms_send_logs inserted with status='sent'
    const log = h.state.calls.find((c) => c.fn === "insert:sms_send_logs")
    expect(log?.args.status).toBe("sent")
    expect(log?.args.credits_used).toBe(2)
    expect(log?.args.flagged).toBe(false)
  })
})

describe("POST /api/shop/sms/send — partial failure", () => {
  it("1 of 2 fails → status=partial, refund 1 credit, credits_used=1", async () => {
    h.sendSMSSpy
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: "provider error" })
    const res = await POST(makeRequest({ message: "Hello", recipients: ["0244000001", "0244000002"] }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.sent).toBe(1)
    expect(body.data.failed).toBe(1)
    expect(body.data.credits_used).toBe(1)
    // refund via adjust_sms_units with positive delta = 1
    const refund = h.state.calls.find((c) => c.fn === "adjust_sms_units" && c.args.p_delta > 0)
    expect(refund?.args.p_delta).toBe(1)
    expect(refund?.args.p_reason).toBe("campaign_refund")
    // log status = 'partial'
    const log = h.state.calls.find((c) => c.fn === "insert:sms_send_logs")
    expect(log?.args.status).toBe("partial")
  })

  it("all 2 fail → status=failed, refund 2 credits", async () => {
    h.sendSMSSpy.mockResolvedValue({ success: false, error: "down" })
    const res = await POST(makeRequest({ message: "Hello", recipients: ["0244000001", "0244000002"] }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.status).toBe("failed")
    const refund = h.state.calls.find((c) => c.fn === "adjust_sms_units" && c.args.p_delta > 0)
    expect(refund?.args.p_delta).toBe(2)
  })

  it("refund itself errors → inserts sms_refund_failures row", async () => {
    h.sendSMSSpy.mockResolvedValue({ success: false, error: "down" })
    h.state.adjustError = true
    const res = await POST(makeRequest({ message: "Hello", recipients: ["0244000001"] }))
    expect(res.status).toBe(200)
    const refundFailure = h.state.calls.find((c) => c.fn === "insert:sms_refund_failures")
    expect(refundFailure).toBeDefined()
    expect(refundFailure?.args.credits).toBe(1)
  })
})

describe("POST /api/shop/sms/send — blocked content", () => {
  it("blocked message → 400, cost 0, log status=blocked, no debit", async () => {
    const res = await POST(makeRequest({
      message: "Enter your pin now",
      recipients: ["0244000001"],
    }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/blocked/i)
    // NO debit
    expect(h.state.calls.find((c) => c.fn === "debit_sms_for_send")).toBeUndefined()
    // log inserted with status=blocked, credits_used=0
    const log = h.state.calls.find((c) => c.fn === "insert:sms_send_logs")
    expect(log?.args.status).toBe("blocked")
    expect(log?.args.credits_used).toBe(0)
  })
})

describe("POST /api/shop/sms/send — gate errors", () => {
  it("insufficient credits → 402", async () => {
    h.state.debitError = "INSUF"
    const res = await POST(makeRequest({ message: "Hello", recipients: ["0244000001"] }))
    expect(res.status).toBe(402)
  })

  it("suspended account → 403", async () => {
    h.state.debitError = "SUSPE"
    const res = await POST(makeRequest({ message: "Hello", recipients: ["0244000001"] }))
    expect(res.status).toBe(403)
  })

  it("inactive account → 403", async () => {
    h.state.debitError = "NOT_A"
    const res = await POST(makeRequest({ message: "Hello", recipients: ["0244000001"] }))
    expect(res.status).toBe(403)
  })
})

describe("POST /api/shop/sms/send — validation", () => {
  it("missing message → 400", async () => {
    const res = await POST(makeRequest({ recipients: ["0244000001"] }))
    expect(res.status).toBe(400)
  })

  it("empty recipients array → 400", async () => {
    const res = await POST(makeRequest({ message: "Hello", recipients: [] }))
    expect(res.status).toBe(400)
  })

  it("message too short (< 3 chars) → 400", async () => {
    const res = await POST(makeRequest({ message: "Hi", recipients: ["0244000001"] }))
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run tests to verify they all fail**

```bash
npx vitest run app/api/shop/sms/send/route.test.ts
```

Expected: all tests fail (module not found or import errors).

- [ ] **Step 3: Implement `app/api/shop/sms/send/route.ts`**

```typescript
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { prepareSmsMessage, type ShopTokens } from "@/lib/sms/prepare"
import { filterSmsContent } from "@/lib/sms/content-filter"
import { calculateSegments } from "@/lib/sms/segments"
import { sendSMS } from "@/lib/sms-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MAX_RECIPIENTS = 500

const BodySchema = z.object({
  message: z.string().min(3).max(1000),
  recipients: z.array(z.string()).min(1).max(MAX_RECIPIENTS),
})

function errorHint(error: { hint?: string; message?: string }): string {
  return error.hint ?? error.message ?? ""
}

export async function POST(request: NextRequest) {
  // Auth
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Validate body
  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await request.json())
  } catch (e: any) {
    return NextResponse.json({ error: "Invalid request", details: e.errors }, { status: 400 })
  }

  // Resolve account
  const account = await getOrCreateAccountForUser(user.id)
  if (!account) {
    return NextResponse.json({ error: "No SMS account for this user" }, { status: 403 })
  }

  // Build shop tokens (graceful fallback when env vars are absent in test)
  const shopTokens: ShopTokens = {
    shop_name:      process.env.SHOP_NAME      ?? "",
    shop_link:      process.env.SHOP_LINK      ?? "",
    shop_phone:     process.env.SHOP_PHONE     ?? "",
    shop_whatsapp:  process.env.SHOP_WHATSAPP  ?? "",
  }

  // Prepare message (strip undeliverables + token substitution)
  let preparedMessage: string
  try {
    preparedMessage = prepareSmsMessage(body.message, shopTokens)
  } catch {
    return NextResponse.json({ error: "Message is empty after stripping unsupported characters" }, { status: 400 })
  }

  // Content filter
  const filterResult = filterSmsContent(preparedMessage)
  if (filterResult.blocked) {
    // Log at cost 0, then return 400
    await supabaseAdmin.from("sms_send_logs").insert({
      sms_account_id:   account.id,
      message:          preparedMessage,
      recipients_count: body.recipients.length,
      segments:         1,
      credits_used:     0,
      status:           "blocked",
      flagged:          true,
      flag_reason:      filterResult.reason ?? "content filter",
    })
    return NextResponse.json({ error: `Message blocked: ${filterResult.reason ?? "content policy"}` }, { status: 400 })
  }

  // Segment / credit calculation (bill prepared text)
  const { segments } = calculateSegments(preparedMessage)
  const creditsNeeded = segments * body.recipients.length

  // Debit (atomic gate: status check + balance debit in one RPC)
  const { data: debitData, error: debitError } = await supabaseAdmin.rpc("debit_sms_for_send", {
    p_account_id: account.id,
    p_credits:    creditsNeeded,
  })
  if (debitError) {
    const hint = errorHint(debitError)
    if (hint === "INSUF") {
      return NextResponse.json({ error: "Insufficient SMS credits" }, { status: 402 })
    }
    if (hint === "SUSPE") {
      return NextResponse.json({ error: "Account is suspended" }, { status: 403 })
    }
    // NOT_A or any other gate failure
    return NextResponse.json({ error: "Account is not activated for sending" }, { status: 403 })
  }

  const balanceAfterDebit: number = (debitData as Array<{ balance_after: number }>)?.[0]?.balance_after ?? 0

  // Send to each recipient
  let sent = 0
  let failed = 0
  for (const phone of body.recipients) {
    const result = await sendSMS({ phone, message: preparedMessage })
    if (result?.success) {
      sent++
    } else {
      failed++
    }
  }

  // Refund failed recipients
  let refundError = false
  if (failed > 0) {
    const refundCredits = segments * failed
    const { error: refErr } = await supabaseAdmin.rpc("adjust_sms_units", {
      p_account_id: account.id,
      p_delta:      refundCredits,
      p_reason:     "campaign_refund",
    })
    if (refErr) {
      refundError = true
      await supabaseAdmin.from("sms_refund_failures").insert({
        sms_account_id: account.id,
        credits:        refundCredits,
        reason:         `Refund failed after send: ${refErr.message}`,
      })
    }
  }

  // Determine final status
  const sendStatus =
    sent === 0 ? "failed" :
    failed > 0 ? "partial" :
    "sent"

  const creditsUsed = segments * sent

  // Audit log
  await supabaseAdmin.from("sms_send_logs").insert({
    sms_account_id:   account.id,
    message:          preparedMessage,
    recipients_count: body.recipients.length,
    segments,
    credits_used:     creditsUsed,
    status:           sendStatus,
    flagged:          filterResult.flagged,
    flag_reason:      filterResult.reason ?? null,
    provider:         "moolre",
  })

  const remaining = refundError
    ? balanceAfterDebit          // can't know exact remaining if refund failed
    : balanceAfterDebit + (segments * failed)

  return NextResponse.json({
    success: true,
    data: {
      total:        body.recipients.length,
      sent,
      failed,
      credits_used: creditsUsed,
      remaining,
      status:       sendStatus,
    },
  })
}
```

- [ ] **Step 4: Run tests to verify they all pass**

```bash
npx vitest run app/api/shop/sms/send/route.test.ts
```

Expected: all tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add app/api/shop/sms/send/route.ts app/api/shop/sms/send/route.test.ts
git commit -m "feat(sms): POST /api/shop/sms/send — metered send pipeline with refund + audit log"
```

---

### Task 7: Run all SMS lib tests together

**Files:** (no new files — verification step)

- [ ] **Step 1: Run the full SMS lib test suite**

```bash
npx vitest run lib/sms/segments.test.ts lib/sms/content-filter.test.ts lib/sms/prepare.test.ts lib/sms/personalize.test.ts app/api/shop/sms/send/route.test.ts
```

Expected output (exact counts may vary): all tests pass, 0 failures across all 5 files.

- [ ] **Step 2: Commit if any stray fixes were needed**

```bash
git add -p   # review any changes
git commit -m "fix(sms): address any cross-module test issues"
```

---

### Task 8: Composer UI — compose tab with live segment/cost meter

**Files:**
- Modify: `app/dashboard/sms/page.tsx`

The existing page has a single view showing balance + bundles. We add a second tab ("Compose") with:
1. A message textarea (live character counter + segment indicator + cost meter)
2. A recipients text area (one number per line)
3. A phone-mock preview bubble showing the rendered message with merge fields applied to a sample
4. A "Send" button that is disabled when `creditsNeeded > balance`
5. A send-history list (from `sms_send_logs` via the existing auth token)

- [ ] **Step 1: Rewrite `app/dashboard/sms/page.tsx`**

Replace the entire file with:

```tsx
"use client"
import { useEffect, useState, useMemo } from "react"
import { supabase } from "@/lib/supabase"
import { calculateSegments } from "@/lib/sms/segments"
import { personalize } from "@/lib/sms/personalize"

type Tab = "balance" | "compose" | "history"

interface Account {
  id: string
  ownerType: string
  unitBalance: number
  pendingUnits: number
  status: string
}

interface Bundle {
  id: string
  name: string
  units: number
  price_ghs: number
}

interface SendLog {
  id: number
  message: string
  recipients_count: number
  segments: number
  credits_used: number
  status: string
  flagged: boolean
  flag_reason: string | null
  created_at: string
}

// Sample contacts for the phone-mock preview
const SAMPLE_CONTACTS = [
  { firstName: "Ama", lastName: "Mensah", phone: "0244000001" },
  { firstName: "Kofi", lastName: "Asante", phone: "0244000002" },
  { firstName: "Akua", lastName: "Darko", phone: "0244000003" },
]

export default function SmsDashboardPage() {
  const [tab, setTab] = useState<Tab>("balance")
  const [account, setAccount] = useState<Account | null>(null)
  const [bundles, setBundles] = useState<Bundle[]>([])
  const [logs, setLogs] = useState<SendLog[]>([])
  const [busy, setBusy] = useState(false)

  // Compose state
  const [message, setMessage] = useState("")
  const [recipientsRaw, setRecipientsRaw] = useState("")
  const [sampleIdx, setSampleIdx] = useState(0)
  const [sendResult, setSendResult] = useState<string | null>(null)

  async function token() {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? ""
  }

  async function load() {
    const t = await token()
    const [accRes, bunRes, logRes] = await Promise.all([
      fetch("/api/sms/account", { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json()),
      fetch("/api/sms/bundles", { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json()),
      fetch("/api/sms/logs", { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json()),
    ])
    setAccount(accRes.account ?? null)
    setBundles(bunRes.bundles ?? [])
    setLogs(logRes.logs ?? [])
  }

  useEffect(() => { load() }, [])

  // Live segment/cost calculation (client-side, same function as server)
  const segResult = useMemo(() => calculateSegments(message), [message])
  const recipients = useMemo(
    () => recipientsRaw.split(/[\n,]+/).map((r) => r.trim()).filter(Boolean),
    [recipientsRaw]
  )
  const creditsNeeded = segResult.segments * recipients.length
  const balanceShort = account !== null && creditsNeeded > account.unitBalance

  // Phone-mock preview with merge fields
  const sampleContact = SAMPLE_CONTACTS[sampleIdx % SAMPLE_CONTACTS.length]
  const previewText = useMemo(
    () => personalize(message || "Your message will appear here…", sampleContact),
    [message, sampleContact]
  )

  async function buy(bundleId: string) {
    setBusy(true)
    const t = await token()
    const res = await fetch("/api/sms/units/purchase-wallet", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId }),
    }).then((r) => r.json())
    setBusy(false)
    if (res.error) {
      alert(res.error)
    } else {
      if (res.pending) alert("Payment received — your units are pending until SMS supply is topped up.")
      await load()
    }
  }

  async function send() {
    if (!message.trim() || recipients.length === 0) return
    setBusy(true)
    setSendResult(null)
    const t = await token()
    const res = await fetch("/api/shop/sms/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: message.trim(), recipients }),
    }).then((r) => r.json())
    setBusy(false)
    if (res.success) {
      const d = res.data
      setSendResult(`Sent ${d.sent}/${d.total} — ${d.credits_used} credits used. Remaining: ${d.remaining}.`)
      setMessage("")
      setRecipientsRaw("")
      await load()
    } else {
      setSendResult(`Error: ${res.error ?? "Send failed"}`)
    }
  }

  const encodingLabel = segResult.encoding === "gsm7" ? "GSM-7" : "Unicode"
  const encodingColor = segResult.encoding === "gsm7" ? "text-green-600" : "text-amber-600"

  return (
    <div className="p-6 space-y-4 max-w-3xl">
      <h1 className="text-2xl font-bold">SMS Console</h1>

      {/* Tab bar */}
      <div className="flex gap-2 border-b">
        {(["balance", "compose", "history"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${
              tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── Balance tab ───────────────────────────────────────── */}
      {tab === "balance" && (
        <div className="space-y-4">
          <div className="rounded-lg border p-4">
            <div className="text-sm text-muted-foreground">SMS Credits</div>
            <div className="text-3xl font-bold">{account?.unitBalance ?? "…"}</div>
            {(account?.pendingUnits ?? 0) > 0 && (
              <div className="mt-1 text-sm text-amber-600">
                {account?.pendingUnits} credits pending (awaiting SMS supply top-up)
              </div>
            )}
            {account?.status === "inactive" && (
              <div className="mt-2 text-sm text-red-600 font-medium">
                Account not activated — purchase a bundle to activate sending.
              </div>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {bundles.map((b) => (
              <div key={b.id} className="rounded-lg border p-4 space-y-2">
                <div className="font-semibold">{b.name}</div>
                <div className="text-sm">
                  {Number(b.units).toLocaleString()} credits · GHS {Number(b.price_ghs).toFixed(2)}
                </div>
                <button
                  disabled={busy}
                  onClick={() => buy(b.id)}
                  className="w-full rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                >
                  Buy with wallet
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Compose tab ───────────────────────────────────────── */}
      {tab === "compose" && (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Left: inputs */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Message</label>
              <textarea
                rows={6}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Type your SMS message… Use [FirstName], [LastName], [Phone] for merge fields."
                className="w-full rounded border px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-primary"
              />
              {/* Live meter */}
              <div className="mt-1 flex flex-wrap gap-3 text-xs">
                <span className="text-muted-foreground">{segResult.length} chars</span>
                <span className={encodingColor}>{encodingLabel}</span>
                <span className="text-muted-foreground">
                  {segResult.segments} segment{segResult.segments !== 1 ? "s" : ""}
                  {" "}· {segResult.remaining} remaining
                </span>
                {recipients.length > 0 && (
                  <span className={balanceShort ? "text-red-600 font-semibold" : "text-muted-foreground"}>
                    {creditsNeeded} credits needed
                    {balanceShort && ` (balance: ${account?.unitBalance ?? 0})`}
                  </span>
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Recipients <span className="text-muted-foreground font-normal">(one per line or comma-separated)</span>
              </label>
              <textarea
                rows={4}
                value={recipientsRaw}
                onChange={(e) => setRecipientsRaw(e.target.value)}
                placeholder="0244000001&#10;0244000002"
                className="w-full rounded border px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <div className="mt-1 text-xs text-muted-foreground">
                {recipients.length} recipient{recipients.length !== 1 ? "s" : ""}
              </div>
            </div>

            <button
              disabled={busy || message.trim().length < 3 || recipients.length === 0 || balanceShort || account?.status === "inactive"}
              onClick={send}
              className="w-full rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? "Sending…" : balanceShort ? "Insufficient credits" : `Send (${creditsNeeded} credits)`}
            </button>

            {sendResult && (
              <p className={`text-sm ${sendResult.startsWith("Error") ? "text-red-600" : "text-green-600"}`}>
                {sendResult}
              </p>
            )}
          </div>

          {/* Right: phone-mock preview */}
          <div className="space-y-3">
            <div className="text-sm font-medium">Preview</div>
            <div className="rounded-2xl border bg-gray-50 dark:bg-gray-900 p-4 shadow-inner min-h-[180px] flex flex-col gap-2">
              <div className="text-xs text-muted-foreground font-medium">SENDER_ID</div>
              <div className="rounded-xl bg-white dark:bg-gray-800 shadow px-4 py-3 text-sm max-w-[85%] leading-relaxed whitespace-pre-wrap">
                {previewText}
              </div>
            </div>
            {/* Sample navigator */}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Sample: {sampleContact.firstName}</span>
              <button
                onClick={() => setSampleIdx((i) => (i - 1 + SAMPLE_CONTACTS.length) % SAMPLE_CONTACTS.length)}
                className="px-2 py-0.5 rounded border hover:bg-muted"
              >
                ◀
              </button>
              <button
                onClick={() => setSampleIdx((i) => (i + 1) % SAMPLE_CONTACTS.length)}
                className="px-2 py-0.5 rounded border hover:bg-muted"
              >
                ▶
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── History tab ───────────────────────────────────────── */}
      {tab === "history" && (
        <div className="space-y-2">
          {logs.length === 0 && (
            <p className="text-sm text-muted-foreground">No sends yet.</p>
          )}
          {logs.map((log) => (
            <div key={log.id} className="rounded-lg border p-3 text-sm space-y-1">
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    log.status === "sent"    ? "bg-green-100 text-green-700" :
                    log.status === "partial" ? "bg-amber-100 text-amber-700" :
                    log.status === "blocked" ? "bg-red-100 text-red-700" :
                                               "bg-gray-100 text-gray-600"
                  }`}
                >
                  {log.status}
                </span>
                {log.flagged && (
                  <span className="text-xs text-amber-600">⚑ flagged</span>
                )}
                <span className="text-xs text-muted-foreground ml-auto">
                  {new Date(log.created_at).toLocaleString()}
                </span>
              </div>
              <p className="text-muted-foreground line-clamp-2">{log.message}</p>
              <div className="text-xs text-muted-foreground">
                {log.recipients_count} recipients · {log.segments} seg · {log.credits_used} credits
                {log.flag_reason && ` · ${log.flag_reason}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create the send-history API endpoint**

The compose tab fetches `/api/sms/logs`. Create `app/api/sms/logs/route.ts`:

```typescript
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ logs: [] })

  const { data } = await supabaseAdmin
    .from("sms_send_logs")
    .select("id, message, recipients_count, segments, credits_used, status, flagged, flag_reason, created_at")
    .eq("sms_account_id", account.id)
    .order("created_at", { ascending: false })
    .limit(50)

  return NextResponse.json({ logs: data ?? [] })
}
```

- [ ] **Step 3: Verify the UI renders without TypeScript errors**

```bash
npx tsc --noEmit
```

Expected: 0 errors. If the `calculateSegments` import shows an error (client component importing from `lib/sms/`), verify the function is exported from a plain `.ts` file with no Node-only imports — it is dependency-free, so it is safe in client components.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/sms/page.tsx app/api/sms/logs/route.ts
git commit -m "feat(sms): composer UI with live segment/cost meter, phone-mock preview, send history"
```

---

### Task 9: Final integration smoke-test + full test run

**Files:** (no new files)

- [ ] **Step 1: Run all SMS tests**

```bash
npm run test:run -- --reporter=verbose
```

Expected: all tests pass. The SMS-related files are:
- `lib/sms/segments.test.ts` — 14 tests
- `lib/sms/content-filter.test.ts` — 16 tests
- `lib/sms/prepare.test.ts` — 9 tests
- `lib/sms/personalize.test.ts` — 9 tests
- `app/api/shop/sms/send/route.test.ts` — 10 tests

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit if any residual fixes**

```bash
git add -p
git commit -m "fix(sms): address integration-test edge cases from final smoke run"
```

---

## Self-Review

### 1. Spec coverage → task mapping

| Spec requirement | Task |
|---|---|
| `lib/sms/segments.ts` — `calculateSegments` + `calculateCredits`, GSM-7 extension chars count 2, UCS-2 emoji=1 code point, 159/160/161 boundaries | Task 1 |
| `lib/sms/content-filter.ts` — dual-pass (plain + normalized), leet/homoglyph/zero-width/de-space evasion, phishing/credential/prize/fake-receipt patterns, shorteners, homoglyph hosts, allowlist-flagging, custom keywords | Task 2 |
| `lib/sms/prepare.ts` — `stripUndeliverableChars`, `prepareSmsMessage`, token substitution, empty-after-strip rejection | Task 3 |
| `lib/sms/personalize.ts` — `MERGE_TOKENS`, `hasMergeTokens`, `personalize`, missing fields leave token in place | Task 4 |
| `sms_send_logs` table with indexes + partial `WHERE flagged`, `sms_refund_failures`, `debit_sms_for_send` RPC with NOT_ACTIVATED/SUSPENDED/INSUFFICIENT_CREDITS raises, RLS owner-SELECT | Task 5 |
| `POST /api/shop/sms/send` — prepare → filter → price → debit → send → refund-failed → log-to-refund-failures → audit, 402/403 gate responses, blocked→cost 0→400, credits_used = segments×sent only | Task 6 |
| Composer UI: compose box, recipients, live segment/cost counter, phone-mock preview with merge-field rendering + prev/next sample, cost blocks send if over balance, send history from sms_send_logs | Task 8 |
| No activation/bonus built here (M2 owns it; status gate enforced inside `debit_sms_for_send` which M2 sets up) | confirmed scope exclusion |
| No admin moderation UI (M4 reads `sms_send_logs` created here) | confirmed scope exclusion |

### 2. Placeholder scan

- All code blocks contain real, runnable TypeScript/SQL — no "TBD", "similar to", or "add error handling" stubs.
- Test assertions use exact values, not `toBeTruthy()` stand-ins.
- Migration verification query is concrete.

### 3. Type consistency

- `SegmentResult.encoding`: `"gsm7" | "unicode"` — used identically in segments.ts, route.ts (destructures only `segments`), and page.tsx.
- `ShopTokens`: defined in `prepare.ts`, imported by `route.ts` — fields match the token strings in `prepareSmsMessage`.
- `RecipientFields`: defined in `personalize.ts` — `phone: string` (required), `firstName?`, `lastName?` — page.tsx passes matching objects from `SAMPLE_CONTACTS`.
- `FilterResult`: `blocked: boolean`, `flagged: boolean`, `reason?: string` — route.ts accesses `.blocked`, `.flagged`, `.reason` consistently.
- `debit_sms_for_send` RPC: hint strings `'NOT_A'`, `'SUSPE'`, `'INSUF'` defined in SQL and matched in route.ts `errorHint()` comparisons.
- `adjust_sms_units` signature used in route.ts (`p_account_id`, `p_delta`, `p_reason`) matches the existing RPC defined in `migrations/0062_create_sms_units_functions.sql`.
- `sms_send_logs` columns in the migration match the insert object in route.ts and the SELECT shape in `app/api/sms/logs/route.ts`.

### 4. Inline verification points

- Task 5 Step 3: verification SQL checks all three artefacts (tables, function, indexes) exist before committing.
- Task 6 tests cover: happy-path all-sent, partial failure with exact refund delta, all-failed, refund-itself-errors→`sms_refund_failures`, blocked→cost-0→400, INSUF/SUSPE/NOT_A gate errors, validation (missing message, empty recipients, message too short).
- Task 9 runs the full suite and a `tsc --noEmit` as a final gate.
