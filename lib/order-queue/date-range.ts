// The queue API only accepts full ISO 8601 datetimes with an offset, so the filter
// panel's local date (+ optional time) inputs are converted here.

type Bound = "from" | "to"

const pad = (n: number) => String(n).padStart(2, "0")

/** Local date ("YYYY-MM-DD") + optional time ("HH:MM") → ISO string; "to" covers the whole day/minute. */
export function rangeBoundToIso(date: string, time: string, bound: Bound): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const t = /^\d{2}:\d{2}$/.test(time) ? time : ""
  const clock = bound === "from" ? `${t || "00:00"}:00` : t ? `${t}:59.999` : "23:59:59.999"
  const d = new Date(`${date}T${clock}`)
  if (!Number.isFinite(d.getTime())) return null
  // Reject rolled-over dates like 2026-02-31.
  if (`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` !== date) return null
  return d.toISOString()
}

/** Inverse of rangeBoundToIso for showing a bound in the inputs; a whole-day bound shows no time. */
export function isoToLocalParts(iso: string | null, bound: Bound): { date: string; time: string } {
  if (!iso) return { date: "", time: "" }
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return { date: "", time: "" }
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const wholeDay = bound === "from" ? time === "00:00" : time === "23:59"
  return { date, time: wholeDay ? "" : time }
}
