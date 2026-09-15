import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { purchaseAirtime } from "@/lib/airtime-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized: Invalid token" }, { status: 401 })
    }

    const phoneGuard = await checkPhoneVerified(supabase, user.id)
    if (!phoneGuard.allowed) {
      return NextResponse.json({ error: phoneGuard.error }, { status: 403 })
    }

    const { network, beneficiaryPhone, airtimeAmount, paySeparately = false, shopId } = await request.json()

    if (!network || !beneficiaryPhone || !airtimeAmount) {
      return NextResponse.json({ error: "network, beneficiaryPhone, and airtimeAmount are required" }, { status: 400 })
    }
    const ALLOWED_NETWORKS = ["MTN", "AirtelTigo", "Telecel"]
    if (!ALLOWED_NETWORKS.includes(network)) {
      return NextResponse.json({ error: "Invalid network. Must be MTN, AirtelTigo, or Telecel" }, { status: 400 })
    }
    const cleanPhone = String(beneficiaryPhone).replace(/\s/g, "")
    if (!/^\d{10}$/.test(cleanPhone)) {
      return NextResponse.json({ error: "Phone number must be exactly 10 digits" }, { status: 400 })
    }
    const amount = parseFloat(airtimeAmount)
    if (isNaN(amount) || amount <= 0 || amount > 1000) {
      return NextResponse.json({ error: "Airtime amount must be between GHS 0.01 and GHS 1000" }, { status: 400 })
    }

    const result = await purchaseAirtime({
      userId: user.id, network, beneficiaryPhone: cleanPhone, airtimeAmount: amount, paySeparately, shopId,
    })

    console.log(`[AIRTIME] ✓ Order created: ${result.order.reference_code} | ${network} GHS ${result.order.airtime_amount} → ${cleanPhone}`)

    return NextResponse.json({
      success: true,
      message: "Airtime order placed successfully",
      order: result.order,
      newBalance: result.newBalance,
    })
  } catch (error: any) {
    const knownCodes = ["NETWORK_DISABLED", "INVALID_AMOUNT", "DUPLICATE_REQUEST", "INSUFFICIENT_BALANCE", "PAYMENT_FAILED", "ORDER_CREATE_FAILED"]
    const status =
      error?.code === "NETWORK_DISABLED" ? 503 :
      error?.code === "INVALID_AMOUNT" ? 400 :
      error?.code === "DUPLICATE_REQUEST" ? 409 :
      error?.code === "INSUFFICIENT_BALANCE" ? 402 :
      error?.code === "PAYMENT_FAILED" || error?.code === "ORDER_CREATE_FAILED" ? 500 :
      500

    if (knownCodes.includes(error?.code)) {
      console.error("[AIRTIME]", error.code, error.message)
      const body: Record<string, unknown> = { error: error.message }
      if (error.reference) body.reference = error.reference
      if (error.required) body.required = error.required
      return NextResponse.json(body, { status })
    }
    console.error("[AIRTIME] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
