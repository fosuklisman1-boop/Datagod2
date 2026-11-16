/**
 * Read a role from Supabase auth `user_metadata` for DISPLAY fallbacks only.
 *
 * user_metadata is written by the user themselves (supabase.auth.signUp options.data, or
 * supabase.auth.updateUser({ data }) at any time), so it can never grant admin. Probe accounts
 * with a forged role "admin" were found in prod (2026-06 and 2026-11). public.users.role is the
 * source of truth; verifyAdminAccess on the server reads only that.
 *
 * Returns a known non-admin role, or null.
 */
const DISPLAY_ROLES = new Set(["user", "dealer", "sub_agent"])

export function roleFromMetadata(meta: unknown): string | null {
  const raw = (meta as { role?: unknown } | null | undefined)?.role
  if (typeof raw !== "string") return null
  const role = raw.trim().toLowerCase()
  return DISPLAY_ROLES.has(role) ? role : null
}
