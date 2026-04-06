import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"

export async function POST(request: NextRequest) {
  // Apply rate limiting
  const rateLimit = await applyRateLimit(
    request,
    'password_reset_confirm',
    RATE_LIMITS.PASSWORD_RESET.maxRequests,
    RATE_LIMITS.PASSWORD_RESET.windowMs
  )

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: RATE_LIMITS.PASSWORD_RESET.message },
      { status: 429 }
    )
  }

  try {
    const { token, newPassword } = await request.json()

    if (!token || !newPassword) {
      return NextResponse.json(
        { error: "Token and new password are required." },
        { status: 400 }
      )
    }

    if (newPassword.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters long." },
        { status: 400 }
      )
    }

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

    // Lookup valid token
    const { data: resetRequest, error: fetchError } = await supabaseServiceRole
      .from("password_reset_requests")
      .select("id, user_id, email, phone_number, expires_at, used")
      .eq("id", token)
      .single()

    if (fetchError || !resetRequest) {
      return NextResponse.json(
        { error: "Invalid or malformed reset token." },
        { status: 400 }
      )
    }

    if (resetRequest.used) {
      return NextResponse.json(
        { error: "This password reset link has already been used." },
        { status: 400 }
      )
    }

    const now = new Date()
    const expiresAt = new Date(resetRequest.expires_at)

    if (now > expiresAt) {
      return NextResponse.json(
        { error: "This password reset link has expired. Please request a new one." },
        { status: 400 }
      )
    }

    // Attempt to update the user's password directly
    const { error: updateError } = await supabaseServiceRole.auth.admin.updateUserById(
      resetRequest.user_id,
      { password: newPassword }
    )

    if (updateError) {
      console.error("[RESET-PASSWORD] Auth admin update error:", updateError)
      return NextResponse.json(
        { error: "Failed to update password. Please try again." },
        { status: 500 }
      )
    }

    // Mark the token as used
    await supabaseServiceRole
      .from("password_reset_requests")
      .update({ used: true })
      .eq("id", resetRequest.id)

    // Send confirmation SMS/Email (optional, as specified by user)
    // "and they should a receice an sms upon succeful pasword change"
    // Fetch the user's details for proper formatting if needed, but we already have phone_number.
    if (resetRequest.phone_number) {
      try {
        await sendSMS({
          phone: resetRequest.phone_number,
          message: "DATAGOD: Your password has been successfully reset. If you did not perform this action, please contact support immediately.",
          type: "password_changed",
        })
      } catch (smsError) {
        console.error("[RESET-PASSWORD] Failed to send confirmation SMS:", smsError)
      }
    }

    return NextResponse.json(
      { success: true, message: "Password updated successfully." },
      { status: 200 }
    )
  } catch (error: any) {
    console.error("[RESET-PASSWORD] Exception:", error)
    return NextResponse.json(
      { error: "An unexpected error occurred." },
      { status: 500 }
    )
  }
}
