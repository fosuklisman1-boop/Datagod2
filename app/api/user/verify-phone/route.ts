import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

export async function POST(request: NextRequest) {
  try {
    const { phoneNumber } = await request.json()

    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: "Invalid authentication" }, { status: 401 })
    }

    if (!phoneNumber || phoneNumber.trim() === "") {
      return NextResponse.json({ error: "Phone number is required" }, { status: 400 })
    }

    // Confirm phone matches what's on file for this user
    const { data: profile } = await supabaseAdmin
      .from("users")
      .select("phone_number")
      .eq("id", user.id)
      .single()

    if (!profile || profile.phone_number !== phoneNumber) {
      return NextResponse.json({ error: "Phone number does not match your account" }, { status: 400 })
    }

    // Require a verified OTP for this phone within the last 30 minutes
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const { data: otpRecord } = await supabaseAdmin
      .from("phone_otp_verifications")
      .select("id")
      .eq("phone", phoneNumber)
      .eq("purpose", "verify_phone")
      .eq("used", true)
      .gte("created_at", thirtyMinutesAgo)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!otpRecord) {
      return NextResponse.json(
        { error: "Phone number must be verified with an OTP first" },
        { status: 400 }
      )
    }

    const { error: updateError } = await supabaseAdmin
      .from("users")
      .update({ phone_verified: true })
      .eq("id", user.id)

    if (updateError) {
      console.error("[VERIFY-PHONE] Update error:", updateError)
      return NextResponse.json({ error: "Failed to mark phone as verified" }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error("[VERIFY-PHONE] Error:", error)
    return NextResponse.json({ error: "Failed to verify phone" }, { status: 500 })
  }
}
