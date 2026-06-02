import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"

export async function POST(request: NextRequest) {
  const rateLimit = await applyRateLimit(
    request,
    "phone_otp",
    RATE_LIMITS.PHONE_OTP.maxRequests,
    RATE_LIMITS.PHONE_OTP.windowMs
  )

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: RATE_LIMITS.PHONE_OTP.message },
      { status: 429 }
    )
  }

  try {
    const { phone, purpose = "signup" } = await request.json()

    if (!phone || phone.trim() === "") {
      return NextResponse.json({ error: "Phone number is required" }, { status: 400 })
    }

    const phoneDigits = phone.replace(/\D/g, "")
    if (phoneDigits.length < 9 || phoneDigits.length > 10) {
      return NextResponse.json({ error: "Phone number must be 9 or 10 digits" }, { status: 400 })
    }

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // Per-phone rate limit: max 3 OTPs per phone per hour (prevent SMS bombing a specific number)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { count } = await supabaseAdmin
      .from("phone_otp_verifications")
      .select("*", { count: "exact", head: true })
      .eq("phone", phone)
      .gte("created_at", oneHourAgo)

    if (count !== null && count >= 3) {
      return NextResponse.json(
        { error: "Too many OTP requests for this number. Please try again later." },
        { status: 429 }
      )
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    const { error: insertError } = await supabaseAdmin
      .from("phone_otp_verifications")
      .insert({ phone, code, expires_at: expiresAt, purpose })

    if (insertError) {
      console.error("[SEND-OTP] Insert error:", insertError)
      return NextResponse.json({ error: "Failed to generate OTP" }, { status: 500 })
    }

    await sendSMS({
      phone,
      message: SMSTemplates.verificationCode(code),
      type: "phone_otp",
    })

    return NextResponse.json({ sent: true })
  } catch (error: any) {
    console.error("[SEND-OTP] Error:", error)
    return NextResponse.json({ error: "Failed to send OTP" }, { status: 500 })
  }
}
