// The app's own password-reset link: a password_reset_requests row whose id is the token, consumed by
// /auth/reset-password?token=... (POST /api/auth/reset-password). Shared by the public forgot-password
// route and the admin "send password reset email" action, so both send the same link.
import type { SupabaseClient } from "@supabase/supabase-js"

/** Lifetime of a reset link; EmailTemplates.passwordReset tells the user it expires in 5 minutes. */
export const RESET_TOKEN_TTL_MINUTES = 5
/** Most reset requests per account per hour (the forgot-password route silently drops more). */
export const RESET_MAX_PER_HOUR = 3

export function passwordResetUrl(token: string): string {
  return `${process.env.NEXT_PUBLIC_APP_URL}/auth/reset-password?token=${token}`
}

/** Reset requests for this user in the last hour; null when the count could not be read. */
export async function recentResetCount(db: SupabaseClient, userId: string): Promise<number | null> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count, error } = await db
    .from("password_reset_requests")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", oneHourAgo)
  return error ? null : count ?? 0
}

/** Insert a reset token for the user and return its link, or null if the insert failed. */
export async function createPasswordResetLink(
  db: SupabaseClient,
  user: { id: string; email: string | null; phone_number: string | null },
): Promise<{ token: string; url: string } | null> {
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000)
  const { data, error } = await db
    .from("password_reset_requests")
    .insert({ user_id: user.id, email: user.email, phone_number: user.phone_number, expires_at: expiresAt.toISOString() })
    .select("id")
    .single()
  if (error || !data) {
    console.error("[PASSWORD-RESET] Token creation error:", error)
    return null
  }
  const token = (data as { id: string }).id
  return { token, url: passwordResetUrl(token) }
}
