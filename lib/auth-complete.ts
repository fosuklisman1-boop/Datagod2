import { createClient } from "@supabase/supabase-js"

/**
 * Decide where to send a user after an auth session has just been established
 * (email-confirmation link or OAuth callback), finalizing their profile if needed.
 *
 * Shared by `app/auth/callback/route.ts` (OAuth / PKCE `?code=`) and
 * `app/auth/confirm/route.ts` (email link `?token_hash=`) so both behave
 * identically:
 *  - profile already has a phone  → go to `next` (onboarded)
 *  - no phone but user_metadata carries first/last/phone (email-confirm signup)
 *    → finalize via the service-role `/api/auth/signup` (re-checks phone OTP,
 *      creates wallet, welcome email), then go to `next`
 *  - otherwise (e.g. Google OAuth with no phone) → `/auth/complete-profile`
 */
export async function resolvePostAuthRedirect(opts: {
  origin: string
  userId: string
  email: string | undefined
  userMetadata: Record<string, any> | null | undefined
  accessToken: string | undefined
  next: string
}): Promise<string> {
  const { origin, userId, email, userMetadata, accessToken, next } = opts
  const safeNext = next.startsWith("/") ? next : "/dashboard"

  const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data: profile } = await supabaseAdmin
    .from("users")
    .select("phone_number")
    .eq("id", userId)
    .maybeSingle()

  if (profile?.phone_number) return safeNext

  const md = userMetadata || {}
  if (md.phone_number && accessToken) {
    try {
      const res = await fetch(`${origin}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          email,
          firstName: md.first_name,
          lastName: md.last_name,
          phoneNumber: md.phone_number,
        }),
      })
      if (res.ok) return safeNext
      console.warn("[AUTH] profile finalize returned", res.status)
    } catch (e) {
      console.error("[AUTH] profile finalize error:", e)
    }
  }

  return "/auth/complete-profile"
}
