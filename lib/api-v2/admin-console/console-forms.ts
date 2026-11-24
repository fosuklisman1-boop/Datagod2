// Browser-safe form rules for the Services and Announcements tabs. They mirror the SQL checks in 0196 so the
// admin sees the problem before sending; the server still re-checks everything.

export const TITLE_MAX = 80
export const BODY_MAX = 1000
export const SERVICE_MESSAGE_MAX = 200
export const SEVERITIES = ["info", "warning", "critical"] as const

const chars = (s: string) => Array.from(s).length

export interface AnnouncementDraft {
  title: string
  body: string
  severity: string
  /** datetime-local values (the admin's own clock, Ghana time = GMT). */
  startsAt: string
  endsAt: string
}

/** A datetime-local value -> ISO with a timezone (the write route refuses timezone-less dates). */
export function fromLocalInput(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null
  const t = new Date(v)
  return Number.isNaN(t.getTime()) ? null : t.toISOString()
}

/** ISO -> a datetime-local value in the admin's own clock. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function validateAnnouncement(d: AnnouncementDraft): string[] {
  const errors: string[] = []
  const title = d.title.trim()
  const body = d.body.trim()
  if (chars(title) < 1 || chars(title) > TITLE_MAX) errors.push(`Title must be 1 to ${TITLE_MAX} characters.`)
  if (chars(body) < 1 || chars(body) > BODY_MAX) errors.push(`Text must be 1 to ${BODY_MAX} characters.`)
  if (!(SEVERITIES as readonly string[]).includes(d.severity)) errors.push("Choose info, warning or critical.")
  const starts = fromLocalInput(d.startsAt)
  const ends = fromLocalInput(d.endsAt)
  if (!starts || !ends) errors.push("Choose a start and an end.")
  else if (Date.parse(ends) <= Date.parse(starts)) errors.push("The end must be after the start.")
  return errors
}

export function serviceMessageOk(m: string): boolean {
  return chars(m.trim()) <= SERVICE_MESSAGE_MAX
}

export function servicePauseCopy(title: string, pausing: boolean): { title: string; body: string; confirm: string } {
  return pausing
    ? {
        title: `Pause ${title}?`,
        body: `For every developer: new purchases and sends stop, order lookups keep working. Requests get 503 with your message (or a standard one). Nothing is revoked and you can resume at any time.`,
        confirm: "Pause service",
      }
    : {
        title: `Resume ${title}?`,
        body: "New purchases and sends work again within a few seconds. The public message is cleared.",
        confirm: "Resume service",
      }
}
