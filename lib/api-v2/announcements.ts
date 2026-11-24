/**
 * Public announcements (spec 7.2): only active ones (starts_at <= now < ends_at), newest first, at most 5, closed
 * severity set and the SQL length limits re-checked. Title and body are returned exactly as stored; the banner
 * renders them as plain text (React escapes), never as HTML.
 *
 * 60 s in-memory cache; on a read error the last good list is served while under 10 minutes old, else an empty
 * list (an announcement must never break a docs page). A missing table (code shipped before the migration) is empty.
 */
import { getAdminClient, type SupabaseLike } from "./store"

export type AnnouncementSeverity = "info" | "warning" | "critical"

export interface PublicAnnouncement {
  id: string
  title: string
  body: string
  severity: AnnouncementSeverity
  endsAt: string
}

export const ANNOUNCEMENTS_MAX = 5
const SEVERITIES = new Set<string>(["info", "warning", "critical"])
const CACHE_MS = 60_000
const LAST_GOOD_MS = 10 * 60_000

const len = (s: string) => Array.from(s).length

export function activeAnnouncements(rows: unknown, now: Date): PublicAnnouncement[] {
  if (!Array.isArray(rows)) return []
  const t = now.getTime()
  const out: { a: PublicAnnouncement; starts: number }[] = []
  for (const r of rows) {
    if (!r || typeof r !== "object") continue
    const o = r as Record<string, unknown>
    if (typeof o.id !== "string" || typeof o.title !== "string" || typeof o.body !== "string") continue
    if (typeof o.severity !== "string" || !SEVERITIES.has(o.severity)) continue
    if (len(o.title) < 1 || len(o.title) > 80 || len(o.body) < 1 || len(o.body) > 1000) continue
    const starts = Date.parse(String(o.starts_at))
    const ends = Date.parse(String(o.ends_at))
    if (Number.isNaN(starts) || Number.isNaN(ends) || !(starts <= t && t < ends)) continue
    out.push({
      a: { id: o.id, title: o.title, body: o.body, severity: o.severity as AnnouncementSeverity, endsAt: new Date(ends).toISOString() },
      starts,
    })
  }
  return out
    .sort((x, y) => y.starts - x.starts)
    .slice(0, ANNOUNCEMENTS_MAX)
    .map((x) => x.a)
}

function isTableMissing(err: unknown): boolean {
  const e = (err ?? {}) as { code?: string; message?: string }
  if (e.code === "42P01" || e.code === "PGRST205") return true
  const m = (e.message ?? "").toLowerCase()
  return m.includes('relation "api_v2_announcements" does not exist') || m.includes('relation "public.api_v2_announcements" does not exist') ||
    (m.includes("could not find the table") && m.includes("api_v2_announcements'"))
}

export function createAnnouncementsService(deps: { client: SupabaseLike; now(): number }): { get(): Promise<PublicAnnouncement[]> } {
  let good: { rows: unknown[]; at: number } | null = null
  let lastAttempt = -Infinity
  let inflight: Promise<PublicAnnouncement[]> | null = null

  const fromMemory = (now: number) => (good && now - good.at < LAST_GOOD_MS ? activeAnnouncements(good.rows, new Date(now)) : [])

  async function refresh(now: number): Promise<PublicAnnouncement[]> {
    try {
      const res = (await deps.client
        .from("api_v2_announcements")
        .select("id, title, body, severity, starts_at, ends_at")
        .gt("ends_at", new Date(now).toISOString())
        // Started only: many scheduled ones must not push the active ones out of the limit below.
        .lte("starts_at", new Date(now).toISOString())
        .order("starts_at", { ascending: false })
        .limit(20)) as { data: unknown; error: unknown }
      if (res.error) {
        if (isTableMissing(res.error)) {
          good = { rows: [], at: now }
          return []
        }
        return fromMemory(now)
      }
      good = { rows: Array.isArray(res.data) ? res.data : [], at: now }
      return activeAnnouncements(good.rows, new Date(now))
    } catch {
      return fromMemory(now)
    }
  }

  return {
    async get() {
      const now = deps.now()
      // Re-filter the cached rows against the clock, so an announcement ends on time even inside the cache window.
      if (good && now - good.at < CACHE_MS) return activeAnnouncements(good.rows, new Date(now))
      if (now - lastAttempt < CACHE_MS && !inflight) return fromMemory(now)
      if (!inflight) {
        lastAttempt = now
        inflight = refresh(now).finally(() => {
          inflight = null
        })
      }
      return inflight
    },
  }
}

let defaultService: ReturnType<typeof createAnnouncementsService> | null = null

/** Lazily built so `next build` with placeholder env never touches the database. */
export async function getPublicAnnouncements(): Promise<PublicAnnouncement[]> {
  if (!defaultService) defaultService = createAnnouncementsService({ client: getAdminClient(), now: () => Date.now() })
  return defaultService.get()
}
