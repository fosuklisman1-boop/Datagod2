const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The `?draft=<uuid>` card id from a location.search string, or null when absent or not a uuid. */
export function parseDraftParam(search: string): string | null {
  const v = new URLSearchParams(search).get("draft")
  return v && UUID.test(v) ? v : null
}

const MAX_BODY = 120

/** Push body for a prepared card: the display title plus a short count/total when the display carries them. Capped at 120 chars. */
export function cardPushBody(display: Record<string, unknown> | null | undefined): string {
  const d = display ?? {}
  const title = typeof d.title === "string" && d.title.trim() ? d.title.trim() : "A prepared action is waiting"
  const bits: string[] = []
  if (typeof d.count === "number" && Number.isFinite(d.count)) bits.push(String(d.count))
  if (typeof d.total_ghs === "number" && Number.isFinite(d.total_ghs)) bits.push(`GHS ${d.total_ghs}`)
  const body = bits.length ? `${title} (${bits.join(", ")})` : title
  return body.slice(0, MAX_BODY)
}
