/**
 * Sidebar "NEW" tag.
 *
 * Owner rule: whenever something new appears in the sidebar it gets a NEW tag,
 * and the tag only goes away when the user clicks that item for the SECOND
 * time (visible at 0 and 1 clicks; the 2nd click clears it for good).
 *
 * Click counts live on the user's account (table `user_nav_clicks`, migration
 * migrations/20261025_user_nav_clicks.sql) so a cleared tag stays cleared on
 * every device. API: GET/POST /api/user/nav-new. Client: useNavNew() in
 * components/layout/use-nav-new.ts; UI: <NewTag /> in components/layout/new-tag.tsx.
 *
 * >>> FUTURE DEVELOPERS: when you add a sidebar/nav item, add its exact href
 * >>> here (with today's date as `since`) so it shows the NEW tag. Prune
 * >>> entries after ~60 days. Admin links in sidebar.tsx are hand-written; an
 * >>> admin href also needs the <NewTag> + markClicked() wiring there (see the
 * >>> /admin/sms link for the pattern). docs/ui-conventions.md has the details.
 */
export const NEW_NAV_ITEMS: Readonly<Record<string, { since: string }>> = Object.freeze({
  "/dashboard/sms": { since: "2026-10-13" },
  "/dashboard/bills": { since: "2026-10-13" },
  "/dashboard/broadband": { since: "2026-10-13" },
  "/dashboard/standard-bundles": { since: "2026-10-13" },
  "/dashboard/top-performers": { since: "2026-10-26" },
  "/admin/leaderboard": { since: "2026-10-26" },
  "/admin/sms": { since: "2026-10-13" },
  "/admin/hubtel-commission": { since: "2026-10-13" },
  "/admin/utility-bills": { since: "2026-10-13" },
})

/** Clicks after which the tag is gone. Mirrors the DB CHECK (clicks BETWEEN 0 AND 2). */
export const NAV_NEW_MAX_CLICKS = 2

/** href -> click count (0..2). */
export type NavClicks = Readonly<Record<string, number>>

export function isRegisteredNavHref(href: unknown): href is string {
  return typeof href === "string" && Object.prototype.hasOwnProperty.call(NEW_NAV_ITEMS, href)
}

function clampCount(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null
  return Math.min(NAV_NEW_MAX_CLICKS, Math.max(0, Math.floor(n)))
}

/**
 * Should `href` show the NEW tag? `clicks === null` means "not loaded yet / load
 * failed" and shows NO tag (fail quiet: better no tag than a tag on items the
 * user already cleared).
 */
export function isNavNew(href: string, clicks: NavClicks | null): boolean {
  if (clicks === null || !isRegisteredNavHref(href)) return false
  const n = Object.prototype.hasOwnProperty.call(clicks, href) ? clampCount(clicks[href]) : 0
  return (n ?? 0) < NAV_NEW_MAX_CLICKS
}

/** Returns a NEW map with `href` incremented (registry hrefs only, capped at 2). */
export function recordNavClick(clicks: NavClicks, href: string): NavClicks {
  if (!isRegisteredNavHref(href)) return clicks
  const current = Object.prototype.hasOwnProperty.call(clicks, href) ? clampCount(clicks[href]) ?? 0 : 0
  return { ...clicks, [href]: Math.min(NAV_NEW_MAX_CLICKS, current + 1) }
}

/** Keep only registry hrefs with numeric counts, clamped to 0..2. */
export function sanitizeNavClicks(raw: unknown): NavClicks {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [href, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isRegisteredNavHref(href)) continue
    const n = clampCount(value)
    if (n !== null) out[href] = n
  }
  return out
}

/** Parse a GET /api/user/nav-new body. Anything unexpected -> null (show no tags). */
export function parseNavClicksPayload(body: unknown): NavClicks | null {
  if (!body || typeof body !== "object") return null
  const b = body as { success?: unknown; data?: { clicks?: unknown } }
  if (b.success !== true || !b.data || typeof b.data !== "object") return null
  const clicks = b.data.clicks
  if (!clicks || typeof clicks !== "object" || Array.isArray(clicks)) return null
  return sanitizeNavClicks(clicks)
}
