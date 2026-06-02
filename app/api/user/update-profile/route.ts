import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

/**
 * POST /api/user/update-profile
 * Updates the caller's NON-sensitive profile fields (name only) via service_role.
 *
 * Why service_role and not a direct authenticated update: public.users had its
 * RLS UPDATE policy stripped by the lockdown, so an authenticated `.update()`
 * matches 0 rows and returns NO error — the write silently no-ops and the value
 * reverts on refresh. service_role bypasses RLS, so this depends only on
 * service_role's table GRANT (migration 0057) and fails LOUD (42501) if it's
 * missing — making this endpoint a reliable probe for whether 0057 is applied.
 *
 * This NEVER touches role or phone_number — those have their own guarded flows
 * (role can't be self-escalated; phone goes through the OTP update-phone route).
 */
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7)

    const { firstName, lastName } = await request.json()
    if (!firstName || !firstName.trim()) {
      return NextResponse.json({ error: "First name is required" }, { status: 400 })
    }

    const supabaseServiceRole = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { data: { user }, error: authError } = await supabaseServiceRole.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: "Invalid authentication" }, { status: 401 })
    }

    const { data, error } = await supabaseServiceRole
      .from("users")
      .update({ first_name: firstName.trim(), last_name: (lastName || "").trim() })
      .eq("id", user.id)
      .select("first_name, last_name")

    if (error) {
      console.error("[/api/user/update-profile] update failed:", error.code, error.message)
      const isGrantError = error.code === "42501"
      return NextResponse.json(
        {
          error: isGrantError
            ? "Database permission error: service_role is missing its GRANT on the users table. Run migration 0057."
            : "Failed to update profile",
          code: error.code,
          details: error.message,
        },
        { status: 500 }
      )
    }

    // service_role bypasses RLS, so a real row WILL match by id. Empty data here
    // means there's genuinely no profile row for this auth user.
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "No profile row found to update" }, { status: 404 })
    }

    return NextResponse.json(
      { success: true, firstName: data[0].first_name, lastName: data[0].last_name },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error: any) {
    console.error("[/api/user/update-profile] error:", error)
    return NextResponse.json({ error: error?.message || "Failed to update profile" }, { status: 500 })
  }
}
