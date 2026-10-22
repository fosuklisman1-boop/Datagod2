import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { defaultPhoneOtpCode, issuePhoneOtp } from "@/lib/phone-otp"

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

  // Short-window burst cap per IP on top of the hourly cap. This endpoint is
  // unauthenticated and triggers a billable SMS to any number the caller types,
  // so block rapid bursts (mass minting / SMS-cost abuse) from a single host.
  const burst = await applyRateLimit(request, "phone_otp_burst", 2, 60_000)
  if (!burst.allowed) {
    return NextResponse.json(
      { error: "Please wait a moment before requesting another code." },
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

    // Per-phone rate limit (max 3 OTPs per phone per hour: prevents SMS bombing a specific number), the code row and
    // the SMS: the shared core (lib/phone-otp), also used in-process by the bots' payer verification.
    const issued = await issuePhoneOtp(
      {
        db: supabaseAdmin,
        sendCode: (to, code) => sendSMS({ phone: to, message: SMSTemplates.verificationCode(code), type: "phone_otp" }),
        now: Date.now,
        randomCode: defaultPhoneOtpCode,
      },
      phone,
      purpose,
    )

    if (!issued.ok && issued.reason === "PHONE_LIMIT") {
      return NextResponse.json(
        { error: "Too many OTP requests for this number. Please try again later." },
        { status: 429 }
      )
    }
    if (!issued.ok) {
      return NextResponse.json({ error: "Failed to generate OTP" }, { status: 500 })
    }

    return NextResponse.json({ sent: true })
  } catch (error: any) {
    console.error("[SEND-OTP] Error:", error)
    return NextResponse.json({ error: "Failed to send OTP" }, { status: 500 })
  }
}
