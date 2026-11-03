/**
 * Sign-up attribution (first touch).
 *
 * The first main-site page a visitor lands on is kept in localStorage
 * (`dg_first_touch`) for 30 days and never overwritten while valid. At sign-up
 * it is carried to the server and stored once on `users.signup_source`.
 *
 * Everything here is self-reported by the browser, so every value is
 * re-validated whenever it is read back (storage, auth metadata, request body,
 * DB rows). No PII: pathname only, referrer host only, and the three utm keys
 * restricted to [A-Za-z0-9._-].
 */

export type SignupSource = {
  landing: string
  ref: string | null
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  at: string
}

export const FIRST_TOUCH_KEY = "dg_first_touch"
export const FIRST_TOUCH_TTL_MS = 30 * 24 * 60 * 60 * 1000

const MAX_LANDING = 200
const MAX_UTM = 60
const MAX_HOST = 253
const MAX_AT = 40
// Allow a little clock skew between devices; anything further ahead is bogus.
const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign"] as const
const UTM_RE = /^[A-Za-z0-9._-]+$/
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/
// A URL pathname is percent-encoded, so none of these appear in a genuine one.
const BAD_LANDING_RE = /[\u0000- \u007f<>"'`\\]/
const EXCLUDED_PREFIXES = ["/dashboard", "/admin", "/auth"]

function isExcludedPath(pathname: string): boolean {
  return EXCLUDED_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

function cleanUtm(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  const s = v.slice(0, MAX_UTM)
  return s && UTM_RE.test(s) ? s : undefined
}

function cleanLanding(v: unknown): string | null {
  if (typeof v !== "string" || !v.startsWith("/")) return null
  const s = v.slice(0, MAX_LANDING)
  return BAD_LANDING_RE.test(s) ? null : s
}

function cleanHost(v: unknown): string | null {
  if (typeof v !== "string" || !v || v.length > MAX_HOST) return null
  const h = v.toLowerCase()
  return HOST_RE.test(h) ? h : null
}

function bareHost(h: string): string {
  return h.replace(/:\d+$/, "").replace(/^www\./, "")
}

function withUtm(base: SignupSource, read: (k: (typeof UTM_KEYS)[number]) => unknown): SignupSource {
  const out: SignupSource = { ...base }
  for (const k of UTM_KEYS) {
    const v = cleanUtm(read(k))
    if (v) out[k] = v
  }
  return out
}

/** Builds the first-touch record for a page view, or null for excluded paths. */
export function buildFirstTouch(url: URL, referrer: string, now: Date): SignupSource | null {
  if (isExcludedPath(url.pathname)) return null
  const landing = cleanLanding(url.pathname)
  if (!landing) return null

  let ref: string | null = null
  if (referrer) {
    try {
      const host = cleanHost(new URL(referrer).host)
      if (host && bareHost(host) !== bareHost(url.host.toLowerCase())) ref = host
    } catch {
      ref = null
    }
  }

  return withUtm({ landing, ref, at: now.toISOString() }, k => url.searchParams.get(k))
}

/** Re-validates a value read back from anywhere. Unknown fields are dropped. */
export function sanitizeSignupSource(v: unknown): SignupSource | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const o = v as Record<string, unknown>

  const landing = cleanLanding(o.landing)
  if (!landing) return null

  if (typeof o.at !== "string" || o.at.length > MAX_AT) return null
  const atMs = Date.parse(o.at)
  if (!Number.isFinite(atMs)) return null

  return withUtm({ landing, ref: cleanHost(o.ref), at: new Date(atMs).toISOString() }, k => o[k])
}

function isFresh(s: SignupSource, now: Date): boolean {
  const age = now.getTime() - Date.parse(s.at)
  return age <= FIRST_TOUCH_TTL_MS && age >= -FUTURE_SKEW_MS
}

/** The stored first touch if valid and younger than 30 days; never throws. */
export function readFirstTouch(storage: Pick<Storage, "getItem">, now: Date): SignupSource | null {
  try {
    const raw = storage.getItem(FIRST_TOUCH_KEY)
    if (!raw) return null
    const s = sanitizeSignupSource(JSON.parse(raw))
    return s && isFresh(s, now) ? s : null
  } catch {
    return null
  }
}

/** Stores `source` only when no valid entry exists. Returns true when written; never throws. */
export function recordFirstTouch(
  storage: Pick<Storage, "getItem" | "setItem">,
  source: SignupSource,
  now: Date,
): boolean {
  if (readFirstTouch(storage, now)) return false
  const clean = sanitizeSignupSource(source)
  if (!clean) return false
  try {
    storage.setItem(FIRST_TOUCH_KEY, JSON.stringify(clean))
    return true
  } catch {
    return false
  }
}

/** Browser helper for sign-up forms: the current first touch, or null (SSR, blocked storage, none). */
export function readFirstTouchFromBrowser(): SignupSource | null {
  try {
    if (typeof window === "undefined") return null
    return readFirstTouch(window.localStorage, new Date())
  } catch {
    return null
  }
}

/** Sign-ups per landing page; invalid/null rows count as "unknown". Sorted by count desc. */
export function countByLanding(rows: Array<{ signup_source: unknown }>): Array<{ landing: string; count: number }> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const landing = sanitizeSignupSource(row?.signup_source)?.landing ?? "unknown"
    counts.set(landing, (counts.get(landing) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([landing, count]) => ({ landing, count }))
    .sort((a, b) => b.count - a.count || a.landing.localeCompare(b.landing))
}
