// Admin console: announcements (write half). Text is stored as typed and only ever rendered as text.
import { bad, callWrite, charLen, NO_ADMIN, REFUSED_MULTI_LINE, REFUSED_SINGLE_LINE, UUID_RE, type RpcClient, type WriteResult } from "./write-common"

// Date AND time AND an explicit timezone (Z or +-HH:MM): a timezone-less time would silently mean server-local time.
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/

function parseDate(v: unknown): string | null {
  if (typeof v !== "string") return null
  const m = ISO_RE.exec(v.trim())
  if (!m) return null
  // Refuse impossible calendar dates (2026-02-31): Date.parse would roll them over into March.
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const cal = new Date(Date.UTC(y, mo - 1, d))
  if (cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== d) return null
  const t = Date.parse(v.trim())
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

export async function saveAnnouncement(
  client: RpcClient,
  p: { id: string | null; title: string; body: string; severity: string; startsAt: string; endsAt: string; actorId: string | undefined }
): Promise<WriteResult> {
  if (!p.actorId) return NO_ADMIN
  if (p.id !== null && (typeof p.id !== "string" || !UUID_RE.test(p.id))) return bad("Not a valid announcement id.")
  const title = typeof p.title === "string" ? p.title.trim() : ""
  const body = typeof p.body === "string" ? p.body.trim() : ""
  if (charLen(title) < 1 || charLen(title) > 80 || REFUSED_SINGLE_LINE.test(title)) return bad("Title must be 1 to 80 characters of plain text.")
  if (charLen(body) < 1 || charLen(body) > 1000 || REFUSED_MULTI_LINE.test(body)) return bad("Text must be 1 to 1000 characters of plain text.")
  if (p.severity !== "info" && p.severity !== "warning" && p.severity !== "critical") return bad("Severity must be info, warning or critical.")
  const starts = parseDate(p.startsAt)
  const ends = parseDate(p.endsAt)
  if (!starts || !ends) return bad("Start and end must be valid dates.")
  if (Date.parse(ends) <= Date.parse(starts)) return bad("The end must be after the start.")

  const out = await callWrite(client, "api_v2_announcement_save", {
    p_id: p.id,
    p_title: title,
    p_body: body,
    p_severity: p.severity,
    p_starts: starts,
    p_ends: ends,
    p_actor: p.actorId,
  })
  if (!out.ok) return out.result
  return { status: 200, body: { ...out.data, ok: true } }
}

export async function deleteAnnouncement(client: RpcClient, p: { id: string; actorId: string | undefined }): Promise<WriteResult> {
  if (!p.actorId) return NO_ADMIN
  if (typeof p.id !== "string" || !UUID_RE.test(p.id)) return bad("Not a valid announcement id.")
  const out = await callWrite(client, "api_v2_announcement_delete", { p_id: p.id, p_actor: p.actorId })
  if (!out.ok) return out.result
  return { status: 200, body: { ...out.data, ok: true } }
}
