// Admin notes and tags on users: the rules the routes, the UI and migrations/0174_admin_user_notes_tags.sql share.
// Pure (no I/O).

/** Offered in the tag picker. Any tag that passes TAG_RE may be used. */
export const SUGGESTED_TAGS = ["vip", "fraud-watch", "bulk-buyer", "reseller", "support-priority"] as const

/** Same as the CHECK on admin_user_tags.tag. */
export const TAG_RE = /^[a-z0-9-]{1,32}$/
export const MAX_TAGS_PER_USER = 20
/** Tags added or removed in one request. */
export const MAX_TAG_CHANGES = 20

export const NOTE_MAX_LENGTH = 2000
/** Notes returned per user (newest first). */
export const NOTES_PAGE_LIMIT = 100

/** Trimmed and lower-cased; null when it is not a valid tag. Spaces and underscores are not turned into "-". */
export function normaliseTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const t = raw.trim().toLowerCase()
  return TAG_RE.test(t) ? t : null
}

export type TagsChange = { add: string[]; remove: string[] }

/** POST /api/admin/users/[id]/tags body: { add?: string[], remove?: string[] }. */
export function parseTagsChange(body: unknown): { ok: true; change: TagsChange } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be { add?, remove? }" }
  const b = body as { add?: unknown; remove?: unknown }
  const out: TagsChange = { add: [], remove: [] }
  for (const key of ["add", "remove"] as const) {
    const v = b[key]
    if (v === undefined) continue
    if (!Array.isArray(v)) return { ok: false, error: `${key} must be an array of tags` }
    for (const raw of v) {
      const t = normaliseTag(raw)
      if (!t) return { ok: false, error: `Invalid tag ${JSON.stringify(raw)}: use 1 to 32 characters a-z, 0-9 and -` }
      if (!out[key].includes(t)) out[key].push(t)
    }
  }
  if (out.add.length + out.remove.length === 0) return { ok: false, error: "Nothing to change" }
  if (out.add.length + out.remove.length > MAX_TAG_CHANGES) return { ok: false, error: `At most ${MAX_TAG_CHANGES} tag changes at once` }
  if (out.add.some((t) => out.remove.includes(t))) return { ok: false, error: "A tag cannot be added and removed at once" }
  return { ok: true, change: out }
}

/** A note body: trimmed, 1..NOTE_MAX_LENGTH characters. */
export function parseNoteBody(raw: unknown): { ok: true; body: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "body is required" }
  const body = raw.trim()
  if (!body) return { ok: false, error: "The note is empty" }
  // Count code points like Postgres' char_length, not UTF-16 units.
  if ([...body].length > NOTE_MAX_LENGTH) return { ok: false, error: `A note is at most ${NOTE_MAX_LENGTH} characters` }
  return { ok: true, body }
}
