// Pure helpers for the v1 retirement UI. No server imports, so client components can use them.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const DAY_MS = 24 * 60 * 60 * 1000
export const MIN_NOTICE_DAYS = 14
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ghana is UTC+0 year-round; always uses UTC getters, never machine-local time. */
export function formatGhanaDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} GMT`
}

/** A datetime-local value ("YYYY-MM-DDTHH:mm") read as GMT/UTC, whatever the browser's timezone. Null when invalid. */
export function pickerToIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  const t = Date.UTC(y, mo - 1, d, h, mi)
  const back = new Date(t)
  // Reject rollovers such as 31 Feb.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return back.toISOString()
}

/** ISO instant -> datetime-local value in GMT. Empty string for null/invalid. */
export function isoToPicker(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toISOString().slice(0, 16)
}

/** True when the date is less than 14 days away (or already past), so the admin must confirm. */
export function isEarlierThanNotice(iso: string, now: Date, days: number = MIN_NOTICE_DAYS): boolean {
  return new Date(iso).getTime() < now.getTime() + days * DAY_MS
}

export function isUuid(s: string): boolean {
  return UUID_RE.test(s.trim())
}

export type BannerKind = "none" | "notice" | "exempt"

/** Banner shows only for a user with an active v1 key while a sunset is set. */
export function bannerKind(args: { sunsetAt: string | null; exempt: boolean; hasActiveKey: boolean }): BannerKind {
  if (!args.sunsetAt || !args.hasActiveKey) return "none"
  if (Number.isNaN(new Date(args.sunsetAt).getTime())) return "none"
  return args.exempt ? "exempt" : "notice"
}

export function bannerText(kind: Exclude<BannerKind, "none">, sunsetAt: string): string {
  const date = formatGhanaDate(new Date(sunsetAt))
  return kind === "exempt"
    ? `API v1 retires on ${date}. Your access continues for now; please plan your move to v2.`
    : `API v1 will be retired on ${date}. After that your v1 requests will be refused. Create a v2 key below and follow the v2 docs.`
}
