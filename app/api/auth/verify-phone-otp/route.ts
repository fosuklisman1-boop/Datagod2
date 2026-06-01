import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

export async function POST(request: NextRequest) {
  try {
    const { phone, code } = await request.json()

    if (!phone || !code) {
      return NextResponse.json({ error: "Phone and code are required" }, { status: 400 })
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
