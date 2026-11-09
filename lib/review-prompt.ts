export const REVIEW_URL_SETTING_KEY = "google_review_url"
export const REVIEW_CARD_STORAGE_KEY = "dg_review_card"
const ALLOWED_HOSTS = ["g.page", "search.google.com", "www.google.com", "maps.app.goo.gl", "g.co"]
const MAX_LEN = 500
const SNOOZE_DAYS = 30

function isAllowed(s: string): boolean {
  try {
    const u = new URL(s)
    return (
      u.protocol === "https:" &&
      ALLOWED_HOSTS.includes(u.hostname) &&
      u.username === "" &&
      u.password === "" &&
      u.port === ""
    )
  } catch {
    return false
  }
}

export function validateReviewUrl(
  v: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === null || v === undefined) return { ok: true, value: null }
  if (typeof v !== "string") return { ok: false, error: "Review link must be text" }
  const s = v.trim()
  if (!s) return { ok: true, value: null }
  if (s.length > MAX_LEN) return { ok: false, error: `Review link must be at most ${MAX_LEN} characters` }
  if (!isAllowed(s)) {
    return { ok: false, error: "Review link must be an https Google link (g.page, search.google.com, www.google.com, maps.app.goo.gl or g.co)" }
  }
  return { ok: true, value: s }
}

export function parseReviewUrl(raw: unknown): string | null {
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw
    const url = (obj as { url?: unknown } | null)?.url
    if (typeof url !== "string") return null
    const r = validateReviewUrl(url)
    return r.ok ? r.value : null
  } catch {
    return null
  }
}

export type ReviewCardState = { dismissedAt?: string; clicked?: boolean }

export function shouldShowReviewCard(state: ReviewCardState | null, now: Date): boolean {
  if (!state) return true
  if (state.clicked) return false
  if (state.dismissedAt) {
    const t = Date.parse(state.dismissedAt)
    if (!Number.isNaN(t) && now.getTime() - t < SNOOZE_DAYS * 86400000) return false
  }
  return true
}
