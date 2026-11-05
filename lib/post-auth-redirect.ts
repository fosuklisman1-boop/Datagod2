/**
 * Post-auth destination handling, shared by the landing page, auth pages,
 * middleware and the OAuth/email-confirm routes so a link clicked before
 * signing in/up is honored after.
 */

const DEFAULT_DESTINATION = "/dashboard"

/**
 * Returns `raw` if it is a safe INTERNAL path, else `fallback`.
 * Rejects absolute/protocol-relative URLs ("//evil.com", "/\evil.com"),
 * control characters, and /auth/* (would loop back into the auth flow).
 */
export function safeRedirectPath(raw: string | null | undefined, fallback: string = DEFAULT_DESTINATION): string {
  if (!raw || typeof raw !== "string") return fallback
  if (!/^\/(?![/\\])/.test(raw)) return fallback
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback
  if (raw === "/auth" || raw.startsWith("/auth/") || raw.startsWith("/auth?")) return fallback
  return raw
}

/** Builds an auth-page URL that remembers where the user was headed. */
export function authUrl(page: "login" | "signup", destination?: string | null): string {
  const base = `/auth/${page}`
  const safe = safeRedirectPath(destination, "")
  return safe ? `${base}?redirect=${encodeURIComponent(safe)}` : base
}
