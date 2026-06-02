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
    return NextResponse.redirect(`${origin}/auth/complete-profile`)
  }

  // Onboarded user — send to intended destination
  const safeNext = next.startsWith("/") ? next : "/dashboard"
  return NextResponse.redirect(`${origin}${safeNext}`)
}
