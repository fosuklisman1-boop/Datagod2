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
    const { referenceCode, phone } = await request.json()
    if (!referenceCode) return NextResponse.json({ error: "referenceCode is required." }, { status: 400 })
    // Require the caller to supply the phone number — proves ownership of the order.
    // Using referenceCode (not the raw UUID orderId) as the lookup key means the caller
    // must know the human-readable reference AND the registered phone, closing the
    // phone-lookup → orderId → resend-spam attack chain.
    if (!phone) return NextResponse.json({ error: "phone is required." }, { status: 400 })

    const normalize = (p: string) => {
      const d = p.replace(/\D/g, "")
      return d.startsWith("233") ? "0" + d.slice(3) : d
    }

    // Fetch order by reference_code — never by raw UUID from client input
    const { data: order } = await supabase
      .from("results_checker_orders")
      .select("id, status, customer_phone, reference_code")
      .eq("reference_code", referenceCode.trim().toUpperCase())
      .eq("status", "completed")
      .single()

    // Verify phone matches before revealing whether the order exists
    if (!order || !order.customer_phone || normalize(phone) !== normalize(order.customer_phone)) {
      return NextResponse.json({ error: "Order not found or not yet completed." }, { status: 404 })
    }

    // Per-phone cap: 3 resends per hour
    const phoneRl = await applyRateLimit(request, "voucher_resend_phone", 3, 60 * 60_000, `ph:${order.customer_phone}`)
    if (!phoneRl.allowed) {
      return NextResponse.json({ error: "Too many resend attempts for this number. Please try again later." }, { status: 429 })
    }

    const result = await resendVouchers(order.id, "sms")
    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 422 })
    }

    return NextResponse.json({ success: true, message: `Vouchers resent to ${order.customer_phone}.` })
  } catch (err) {
    console.error("[VOUCHER-RESEND]", err)
    return NextResponse.json({ error: "Internal server error." }, { status: 500 })
  }
}
