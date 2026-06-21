import { NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import { cookies } from "next/headers"

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get("code")
  const next = searchParams.get("next") ?? "/dashboard"

  if (!code) {
    return NextResponse.redirect(`${origin}/auth/login?error=oauth_failed`)
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

  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    console.error("[AUTH CALLBACK] Code exchange error:", error)
    return NextResponse.redirect(`${origin}/auth/login?error=oauth_failed`)
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.redirect(`${origin}/auth/login?error=oauth_failed`)
  }

  // Check if a public.users profile already exists for this auth user
  const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data: profile } = await supabaseAdmin
    .from("users")
    .select("phone_number")
    .eq("id", user.id)
    .maybeSingle()

  // "Onboarded" = has a phone number. The handle_new_user trigger (migration 0058)
  // gives every auth user a public.users row immediately, so a missing row is no
  // longer the signal — a row WITHOUT a phone (or no row at all) both mean "not yet
  // onboarded" → complete-profile (which collects phone + terms + name).
  if (!profile || !profile.phone_number) {
    // Email-confirmation signups carry first/last/phone in user_metadata (set in
    // authService.signUp). Finalize the profile via the service-role signup route
    // — it re-checks the phone OTP, creates the wallet, and sends the welcome
    // email — so the user skips re-entering their phone. Fall through to
    // complete-profile on any miss (OTP expired, or a Google OAuth user with no
    // metadata phone).
    const md = (user.user_metadata || {}) as {
      first_name?: string
      last_name?: string
      phone_number?: string
    }
    if (md.phone_number) {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (token) {
        try {
          const res = await fetch(`${origin}/api/auth/signup`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              email: user.email,
              firstName: md.first_name,
              lastName: md.last_name,
              phoneNumber: md.phone_number,
            }),
          })
          if (res.ok) {
            const safeNext = next.startsWith("/") ? next : "/dashboard"
            return NextResponse.redirect(`${origin}${safeNext}`)
          }
          console.warn("[AUTH CALLBACK] profile finalize returned", res.status)
        } catch (e) {
          console.error("[AUTH CALLBACK] profile finalize error:", e)
        }
      }
    }
    return NextResponse.redirect(`${origin}/auth/complete-profile`)
  }

  // Onboarded user — send to intended destination
  const safeNext = next.startsWith("/") ? next : "/dashboard"
  return NextResponse.redirect(`${origin}${safeNext}`)
}
