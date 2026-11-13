/**
 * The "received" time the SMS forwarder may send. Pure. Accepts ISO 8601 (no timezone = UTC), "YYYY-MM-DD HH:mm:ss" (UTC),
 * epoch seconds (10 digits) and epoch milliseconds (13 digits). Anything else, or a time outside 2020-01-01 .. now + 1 day,
 * is null (the lane then treats the message as having no receive time).
 */
const MIN_MS = Date.UTC(2020, 0, 1)
const DAY_MS = 24 * 60 * 60 * 1000
const ISO = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})?$/i

export function parseReceived(value: unknown, now: Date): Date | null {
  let s: string
  if (typeof value === "string") s = value.trim()
  else if (typeof value === "number" && Number.isFinite(value)) s = String(value)
  else return null
  if (s.length === 0) return null

  let ms: number
  if (/^\d{10}$/.test(s)) ms = Number(s) * 1000
  else if (/^\d{13}$/.test(s)) ms = Number(s)
  else {
    const m = ISO.exec(s)
    if (!m) return null
    const time = m[2].length === 5 ? `${m[2]}:00` : m[2]
    const zone = m[3] ? (m[3].toUpperCase() === "Z" || m[3].includes(":") ? m[3].toUpperCase() : `${m[3].slice(0, 3)}:${m[3].slice(3)}`) : "Z"
    ms = Date.parse(`${m[1]}T${time}${zone}`)
  }

  if (!Number.isFinite(ms) || ms < MIN_MS || ms > now.getTime() + DAY_MS) return null
  return new Date(ms)
}
