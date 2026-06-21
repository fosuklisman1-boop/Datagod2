import { NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { resolvePostAuthRedirect } from "@/lib/auth-complete"

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

  // Resolve where to send them (and finalize the profile from user_metadata for
  // email-confirm signups). Shared with /auth/confirm so both paths behave the same.
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
