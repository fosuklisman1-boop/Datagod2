import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"
import { resendVouchers } from "@/lib/results-checker-notification-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  // IP-level cap: 3 per minute
  const ipRl = await applyRateLimit(request, "voucher_resend_ip", 3, 60_000)
  if (!ipRl.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait before trying again." }, { status: 429 })
  }

  try {
    const { orderId } = await request.json()
    if (!orderId) return NextResponse.json({ error: "orderId is required." }, { status: 400 })

    // Fetch order to verify it's completed and get the phone for per-phone rate limit
    const { data: order } = await supabase
      .from("results_checker_orders")
      .select("id, status, customer_phone, reference_code")
      .eq("id", orderId)
      .eq("status", "completed")
      .single()

    if (!order) {
      return NextResponse.json({ error: "Order not found or not yet completed." }, { status: 404 })
    }

    if (!order.customer_phone) {
      return NextResponse.json({ error: "No phone number on record for this order." }, { status: 422 })
    }

    // Per-phone cap: 3 resends per hour
    const phoneRl = await applyRateLimit(request, "voucher_resend_phone", 3, 60 * 60_000, `ph:${order.customer_phone}`)
    if (!phoneRl.allowed) {
      return NextResponse.json({ error: "Too many resend attempts for this number. Please try again later." }, { status: 429 })
    }

    const result = await resendVouchers(orderId, "sms")
    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 422 })
    }

    return NextResponse.json({ success: true, message: `Vouchers resent to ${order.customer_phone}.` })
  } catch (err) {
    console.error("[VOUCHER-RESEND]", err)
    return NextResponse.json({ error: "Internal server error." }, { status: 500 })
  }
}
