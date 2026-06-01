import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"

export async function POST(request: NextRequest) {
  try {
    const { phone, code } = await request.json()

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

    const now = new Date().toISOString()

    const { data: record } = await supabaseAdmin
      .from("phone_otp_verifications")
      .select("id")
      .eq("phone", phone)
      .eq("code", code)
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
