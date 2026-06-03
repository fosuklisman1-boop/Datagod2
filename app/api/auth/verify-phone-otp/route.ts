import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"

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
    const phoneKey = String(phone).replace(/\D/g, "")
    const perPhone = await applyRateLimit(request, "verify_phone_otp_phone", 6, 10 * 60 * 1000, `otpv:${phoneKey}`)
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

    // DB-backed brute-force fallback. The Upstash caps above FAIL OPEN if Redis
    // is unreachable, which would re-expose the 6-digit code to guessing. This
    // Postgres counter holds regardless: bump_otp_attempts() increments `attempts`
    // on every live code for the phone and returns the new max; we reject once it
    // exceeds the cap. Counts expire with the codes (10-min window) — no cleanup.
    const PHONE_ATTEMPT_CAP = 6
    let dbFallbackOk = false
    try {
      const { data: maxAttempts, error: bumpErr } = await supabaseAdmin.rpc("bump_otp_attempts", { p_phone: phone })
      if (!bumpErr) {
        dbFallbackOk = true
        if (typeof maxAttempts === "number" && maxAttempts > PHONE_ATTEMPT_CAP) {
          return NextResponse.json(
            { verified: false, error: "Too many attempts. Request a new code and try again later." },
            { status: 429 }
          )
        }
      }
    } catch {
      // bump_otp_attempts unavailable (migration not applied / DB blip) — handled
      // by the fail-closed check below. Apply migrations/otp_verify_attempts_fallback.sql.
    }

    // FAIL CLOSED: if BOTH brute-force defences are unavailable (Upstash degraded
    // AND the DB counter unavailable), there is no cap left and the 6-digit code
    // could be sprayed out. Refuse to verify rather than become an open oracle.
    if (!dbFallbackOk && (perPhone.degraded || perIp.degraded)) {
      console.error("[VERIFY-OTP] Both rate limiters unavailable — failing closed")
      return NextResponse.json(
        { verified: false, error: "Verification is temporarily unavailable. Please try again shortly." },
        { status: 503 }
      )
    }

    const now = new Date().toISOString()

    const { data: record } = await supabaseAdmin
      .from("phone_otp_verifications")
      .select("id")
      .eq("phone", phone)
      .eq("code", code)
      .eq("purpose", purpose)
      .eq("used", false)
      .gte("expires_at", now)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!record) {
      return NextResponse.json({ verified: false, error: "Invalid or expired code" }, { status: 400 })
    }

    await supabaseAdmin
      .from("phone_otp_verifications")
      .update({ used: true })
      .eq("id", record.id)

    return NextResponse.json({ verified: true })
  } catch (error: any) {
    console.error("[VERIFY-OTP] Error:", error)
    return NextResponse.json({ error: "Failed to verify OTP" }, { status: 500 })
  }
}
