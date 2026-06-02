import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

export async function POST(request: NextRequest) {
  try {
    const { phoneNumber } = await request.json()

    // Get the auth token from the request
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const token = authHeader.slice(7)

    // Create a service role client
    const supabaseServiceRole = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    )

    // Verify the user's token
    const { data: { user }, error: authError } = await supabaseServiceRole.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json(
        { error: "Invalid authentication" },
        { status: 401 }
      )
    }

    // Phone number is required
    if (!phoneNumber || phoneNumber.trim() === '') {
      return NextResponse.json(
        { error: "Phone number is required" },
        { status: 400 }
      )
    }

    // Validate phone number (9-10 digits)
    const phoneDigits = (phoneNumber || '').replace(/\D/g, '')
    if (phoneDigits.length < 9 || phoneDigits.length > 10) {
      return NextResponse.json(
        { error: "Phone number must be 9 or 10 digits" },
        { status: 400 }
      )
    }

    // Require server-side proof that phone OTP was verified within the last 30 minutes
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const { data: otpRecord } = await supabaseServiceRole
      .from("phone_otp_verifications")
      .select("id")
      .eq("phone", phoneNumber)
      .eq("purpose", "update_phone")
      .eq("used", true)
      .gte("created_at", thirtyMinutesAgo)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!otpRecord) {
      return NextResponse.json(
        { error: "Phone number must be verified with an OTP before updating" },
        { status: 400 }
      )
    }

    // Check if phone number already exists for a DIFFERENT user
    const { data: existingUser, error: checkError } = await supabaseServiceRole
      .from("users")
      .select("id")
      .eq("phone_number", phoneNumber)
      .neq("id", user.id) // Exclude current user
      .maybeSingle()

    if (existingUser) {
      return NextResponse.json(
        { error: "This phone number is already registered" },
        { status: 400 }
      )
    }

    // Update the user's phone number using service role (bypasses RLS)
    const { error: updateError } = await supabaseServiceRole
      .from("users")
      .update({ phone_number: phoneNumber, phone_verified: true })
      .eq("id", user.id)

    if (updateError) {
      // Surface the REAL Postgres error instead of a generic message. A 42501
      // here means service_role's table GRANT on public.users is still stripped
      // (run migration 0057_restore_users_grants_and_policies.sql) — not a code bug.
      console.error("Error updating phone number:", updateError.code, updateError.message)
      const isGrantError = updateError.code === "42501"
      return NextResponse.json(
        {
          error: isGrantError
            ? "Database permission error: service_role is missing its GRANT on the users table. Run migration 0057."
            : "Failed to update phone number",
          code: updateError.code,
          details: updateError.message,
        },
        { status: 500 }
      )
    }

    return NextResponse.json(
      { success: true, message: "Phone number updated successfully" },
      { status: 200 }
    )
  } catch (error: any) {
    console.error("Update phone API error:", error)
    return NextResponse.json(
      { error: "Failed to update phone number" },
      { status: 500 }
    )
  }
}
