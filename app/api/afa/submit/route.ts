import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { submitAfaOrder } from "@/lib/afa-fulfillment"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.substring(7)
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const phoneGuard = await checkPhoneVerified(supabase, user.id)
    if (!phoneGuard.allowed) {
      return NextResponse.json({ error: phoneGuard.error }, { status: 403 })
    }

    const body = await request.json()
    const { fullName, phoneNumber, ghCardNumber, location, region, occupation, userId } = body

    if (!fullName || !phoneNumber || !ghCardNumber || !location || !region || !userId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }
    if (userId !== user.id) {
      return NextResponse.json({ error: "User ID mismatch" }, { status: 401 })
    }

    const result = await submitAfaOrder({ userId: user.id, fullName, phoneNumber, ghCardNumber, location, region, occupation })

    return NextResponse.json({ success: true, order: result.order, message: "AFA registration submitted successfully" }, { status: 200 })
  } catch (error: any) {
    if (error?.code === "PRICE_UNAVAILABLE") {
      return NextResponse.json({ error: error.message }, { status: 503 })
    }
    if (error?.code === "INSUFFICIENT_BALANCE") {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    if (error?.code === "PAYMENT_FAILED" || error?.code === "ORDER_CREATE_FAILED") {
      console.error("[AFA-SUBMIT] Order/payment error:", error)
      return NextResponse.json({ error: error.message, details: error.message }, { status: 500 })
    }
    console.error("[AFA-SUBMIT] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error", details: "Failed to submit order. Please try again." }, { status: 500 })
  }
}
