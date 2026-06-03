import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"
import { phoneVariants } from "@/lib/phone-format"
import { sendSMS } from "@/lib/sms-service"

/**
 * POST /api/auth/set-password  { newPassword }   (Authorization: Bearer <token>)
 *
 * Lets an authenticated user (typically a Google/OAuth account with no password)
 * set a password so they can also sign in with email + password. Because there is
 * no current password to verify, we require a fresh phone OTP as the second factor
 * — the SAME server-side proof model as update-phone: a phone_otp_verifications row
 * for the user's registered number with used=true, purpose='set_password', recent.
 *
 * The password write uses the service-role admin API (like reset-password), so it
 * works regardless of how the user originally authenticated.
 */
export async function POST(request: NextRequest) {
  // Per-IP throttle (reuse the password-reset budget).
  const rl = await applyRateLimit(request, "set_password", 3, 60 * 60 * 1000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429 }
    )
  }

  try {
    const { newPassword } = await request.json()

    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7)

    if (!newPassword || typeof newPassword !== "string" || newPassword.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters long." },
        { status: 400 }
      )
    }

    const supabaseServiceRole = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // Identify the caller from their access token.
    const { data: { user }, error: authError } = await supabaseServiceRole.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: "Invalid authentication" }, { status: 401 })
    }

    // The OTP must go to — and be proven against — the user's own registered phone.
    const { data: profile } = await supabaseServiceRole
      .from("users")
      .select("phone_number")
      .eq("id", user.id)
      .maybeSingle()

    if (!profile?.phone_number) {
      return NextResponse.json(
        { error: "Add and verify a phone number on your profile before setting a password." },
        { status: 400 }
      )
    }

    // Require server-side proof that a set_password OTP was verified for THIS user's
    // phone within the last 30 minutes (match across format variants).
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const { data: otpRecord } = await supabaseServiceRole
      .from("phone_otp_verifications")
      .select("id")
      .in("phone", phoneVariants(profile.phone_number))
      .eq("purpose", "set_password")
      .eq("used", true)
      .gte("created_at", thirtyMinutesAgo)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!otpRecord) {
      return NextResponse.json(
        { error: "Please verify the code sent to your phone before setting a password." },
        { status: 400 }
      )
    }

    const { error: updateError } = await supabaseServiceRole.auth.admin.updateUserById(
      user.id,
      { password: newPassword }
    )

    if (updateError) {
      console.error("[SET-PASSWORD] Auth admin update error:", updateError.message)
      return NextResponse.json(
        { error: "Failed to set password. Please try again." },
        { status: 500 }
      )
    }

    // Confirmation SMS (best-effort) — same message/type the reset flow sends.
    try {
      await sendSMS({
        phone: profile.phone_number,
        message: "DTGOD: A password was just set on your account. If this wasn't you, contact support immediately.",
        type: "password_changed",
      })
    } catch (smsError) {
      console.error("[SET-PASSWORD] Failed to send confirmation SMS:", smsError)
    }

    return NextResponse.json(
      { success: true, message: "Password set successfully." },
      { status: 200 }
    )
  } catch (error: any) {
    console.error("[SET-PASSWORD] Exception:", error)
    return NextResponse.json({ error: "An unexpected error occurred." }, { status: 500 })
  }
}
