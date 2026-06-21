import { NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import type { EmailOtpType } from "@supabase/supabase-js"
import { resolvePostAuthRedirect } from "@/lib/auth-complete"

/**
 * Email confirmation / magic-link verifier on OUR domain.
 *
 * GoTrue email templates link here (datagod.store/auth/confirm?token_hash=...&type=...)
 * instead of the default *.supabase.co verify URL. Keeping the link on our own
 * domain (matching the sender) is a major deliverability win — sender/link domain
 * mismatch is a strong spam signal. We verify the OTP with the token_hash, which
 * establishes the session, then finalize the profile and redirect.
 *
 * Password reset is NOT handled here — the app uses its own custom token flow
 * (`/auth/reset-password?token=` -> `/api/auth/reset-password`).
 */
const ALLOWED_TYPES: EmailOtpType[] = ["signup", "email", "magiclink", "invite", "email_change"]

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const token_hash = searchParams.get("token_hash")
  const type = searchParams.get("type") as EmailOtpType | null
  const next = searchParams.get("next") ?? "/dashboard"

  if (!token_hash || !type || !ALLOWED_TYPES.includes(type)) {
    return NextResponse.redirect(`${origin}/auth/login?error=invalid_link`)
  }

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )

  const { error } = await supabase.auth.verifyOtp({ type, token_hash })
  if (error) {
    console.error("[AUTH CONFIRM] verifyOtp error:", error.message)
    return NextResponse.redirect(`${origin}/auth/login?error=link_expired`)
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(`${origin}/auth/login?error=link_expired`)
  }

  const {
    data: { session },
  } = await supabase.auth.getSession()

  const target = await resolvePostAuthRedirect({
    origin,
    userId: user.id,
    email: user.email,
    userMetadata: user.user_metadata,
    accessToken: session?.access_token,
    next,
  })

  return NextResponse.redirect(`${origin}${target}`)
}
