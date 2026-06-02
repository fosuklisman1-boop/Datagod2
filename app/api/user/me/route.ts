import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

/**
 * GET /api/user/me
 * Returns the CURRENT user's profile essentials, read via the service-role key
 * so the answer never depends on the `authenticated` role's RLS SELECT policy
 * on public.users (which the lockdown left missing — the reason the phone gate
 * stopped firing). The caller proves identity with their Supabase access token;
 * we resolve it to a user id and read only THAT row, so this leaks nothing.
 *
 *   exists:    is there a public.users row for this auth user?
 *   hasPhone:  does that row have a phone number?
 *   role/name: convenience fields for the dashboard.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const token = authHeader.slice(7)

  const supabaseServiceRole = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data: { user }, error: authError } = await supabaseServiceRole.auth.getUser(token)
  if (authError || !user) {
    return NextResponse.json({ error: "Invalid authentication" }, { status: 401 })
  }

  const { data: profile, error: profileError } = await supabaseServiceRole
    .from("users")
    .select("first_name, last_name, role, phone_number")
    .eq("id", user.id)
    .maybeSingle()

  // If service_role itself can't read users (its table GRANT is still stripped),
  // surface it explicitly — this is the one privilege everything now hinges on.
  if (profileError) {
    console.error("[/api/user/me] users read failed:", profileError.message, profileError.code)
    return NextResponse.json(
      { error: "profile_read_failed", code: profileError.code, details: profileError.message },
      { status: 500 }
    )
  }

  return NextResponse.json(
    {
      exists: !!profile,
      hasPhone: !!profile?.phone_number,
      role: profile?.role ?? "user",
      firstName: profile?.first_name ?? null,
      lastName: profile?.last_name ?? null,
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
