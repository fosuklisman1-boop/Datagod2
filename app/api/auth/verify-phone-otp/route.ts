import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneOtp, phoneOtpVerifyLimitId, PHONE_OTP_VERIFY_PHONE_LIMIT } from "@/lib/phone-otp"

export async function POST(request: NextRequest) {
  try {
    const { phone, code, purpose = "signup" } = await request.json()

    if (!phone || !code) {
      return NextResponse.json({ error: "Phone and code are required" }, { status: 400 })
    }

    // Brute-force defence. The code is 6 digits with up to 3 active codes per
    // phone (10-min window). Without an attempt cap an attacker can trigger
    // send-otp for a number they DON'T own, then spray codes here until one
    // matches — and a match flips used=true, which permanently "verifies" (and
    // grandfathers) that number. Two caps close it:
    //   • per-phone: 6 guesses / 10 min  → far below the ~150k needed to brute a 6-digit code
    //   • per-IP:    20 / min            → stops spraying many phones from one host
    // (Shared with the bots' in-process payer verification: same bucket, verify_phone_otp_phone / otpv:<digits>.)
    const cap = PHONE_OTP_VERIFY_PHONE_LIMIT
    const perPhone = await applyRateLimit(request, cap.name, cap.max, cap.windowMs, phoneOtpVerifyLimitId(phone))
    if (!perPhone.allowed) {
      return NextResponse.json(
        { verified: false, error: "Too many attempts. Request a new code and try again later." },
        { status: 429 }
      )
    }
    const perIp = await applyRateLimit(request, "verify_phone_otp_ip", 20, 60 * 1000)
    if (!perIp.allowed) {
      return NextResponse.json(
        { verified: false, error: "Too many attempts. Please wait a moment." },
        { status: 429 }
      )
    }

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // DB-backed brute-force fallback + the code match, in the shared core (lib/phone-otp; also used in-process by the
    // bots' payer verification). The Upstash caps above FAIL OPEN if Redis is unreachable, which would re-expose the
    // 6-digit code to guessing. The Postgres counter holds regardless: bump_otp_attempts() increments `attempts` on
    // every live code for the phone and returns the new max; the core rejects once it exceeds the cap (counts expire
    // with the codes, 10-min window). It FAILS CLOSED only if that DB-backed cap is unavailable (apply
    // migrations/otp_verify_attempts_fallback.sql); Upstash degrading alone does not block verification.
    const result = await checkPhoneOtp({ db: supabaseAdmin, now: Date.now }, phone, code, purpose)

    if (result === "too_many_attempts") {
      return NextResponse.json(
        { verified: false, error: "Too many attempts. Request a new code and try again later." },
        { status: 429 }
      )
    }
    if (result === "unavailable") {
      return NextResponse.json(
        { verified: false, error: "Verification is temporarily unavailable. Please try again shortly." },
        { status: 503 }
      )
    }
    if (result !== "verified") {
      return NextResponse.json({ verified: false, error: "Invalid or expired code" }, { status: 400 })
    }

    return NextResponse.json({ verified: true })
  } catch (error: any) {
    console.error("[VERIFY-OTP] Error:", error)
    return NextResponse.json({ error: "Failed to verify OTP" }, { status: 500 })
  }
}
