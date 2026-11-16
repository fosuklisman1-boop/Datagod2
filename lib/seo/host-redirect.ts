/**
 * app.<root> and admin.<root> served the whole main site as duplicate hosts.
 * Pure (edge-safe): middleware.ts 308s them to the same path on www.<root>.
 *
 * Nothing in this codebase or the mobile app links to either host (the mobile
 * app and auth links use www / NEXT_PUBLIC_APP_URL; Google OAuth returns to
 * window.location.origin). /auth/callback is still left alone: an OAuth sign-in
 * started on one of these hosts before this redirect shipped keeps its PKCE
 * code-verifier cookie on that host, and would fail if the callback moved.
 * API paths never reach here (the middleware matcher skips /api) and the api.
 * host is handled separately.
 */
const LEGACY_LABELS = new Set(["app", "admin"])
const KEEP_PATHS = ["/auth/callback"]

export function legacyHostRedirect(
  host: string | null | undefined,
  path: string,
  rootDomain: string,
): string | null {
  if (!host) return null
  const hostname = host.trim().toLowerCase().replace(/:\d+$/, "")
  const root = rootDomain.toLowerCase()
  if (!hostname.endsWith(`.${root}`)) return null
  const label = hostname.slice(0, -(root.length + 1))
  if (!LEGACY_LABELS.has(label)) return null
  if (path.startsWith("/api/") || path === "/api") return null
  if (KEEP_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return null
  return `https://www.${root}${path}`
}
