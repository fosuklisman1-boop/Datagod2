import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { submitOtp } from "@/lib/paystack"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * POST /api/payments/submit-otp
 *
 * Called by the web direct-MoMo-charge modal when the initial charge came back
 * with status "send_otp" (Telecel Cash requires an OTP; MTN/AirtelTigo use a
 * push-to-approve prompt instead and never hit this). Wraps Paystack's
 * POST /charge/submit_otp. Final success/failure still arrives via the
 * charge.success/charge.failed webhook — this only forwards the code and,
 * mirroring the WhatsApp/USSD bot's same OTP handler, marks the order failed
 * immediately on a synchronously-rejected OTP so the polling modal doesn't
 * wait indefinitely for a webhook that may not fire for a bad code.
 *
 *   body: { reference: string, otp: string, orderId?: string, orderType?: string }
 */
export async function POST(request: NextRequest) {
  const rl = await applyRateLimit(request, "momo_submit_otp", RATE_LIMITS.MOMO_SUBMIT_OTP.maxRequests, RATE_LIMITS.MOMO_SUBMIT_OTP.windowMs)
  if (!rl.allowed) {
    return NextResponse.json({ success: false, error: RATE_LIMITS.MOMO_SUBMIT_OTP.message }, { status: 429 })
  }

  const body = await request.json().catch(() => ({}))
  const reference = String(body.reference || "").trim()
  const otp = String(body.otp || "").trim()
  const orderId = body.orderId ? String(body.orderId) : null
  const orderType = body.orderType ? String(body.orderType) : "data"

  if (!reference || !otp) {
    return NextResponse.json({ success: false, error: "reference and otp are required" }, { status: 400 })
  }

  try {
    const { status } = await submitOtp(reference, otp)

    if (status === "failed") {
      await markFailed(orderId, orderType, reference)
      return NextResponse.json({ success: false, status, error: "That code was rejected. Please try again." })
    }

    return NextResponse.json({ success: true, status })
  } catch (err) {
    console.error("[SUBMIT-OTP] Error:", err)
    await markFailed(orderId, orderType, reference)
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "OTP submission failed" },
      { status: 500 }
    )
  }
}

async function markFailed(orderId: string | null, orderType: string, reference: string): Promise<void> {
  try {
    if (orderId) {
      const table = orderType === "airtime" ? "airtime_orders"
        : orderType === "results_checker" ? "results_checker_orders"
        : orderType === "results_check_service" ? "results_check_requests"
        : "shop_orders"
      const updateData: Record<string, unknown> = { payment_status: "failed", updated_at: new Date().toISOString() }
      if (orderType === "airtime" || orderType === "results_checker" || orderType === "results_check_service") {
        updateData.status = "failed"
      } else {
        updateData.order_status = "failed"
      }
      await supabase.from(table).update(updateData).eq("id", orderId)
    } else {
      await supabase.from("wallet_payments").update({ status: "failed" }).eq("reference", reference)
    }
  } catch (err) {
    console.error("[SUBMIT-OTP] Failed to mark order/payment failed:", err)
  }
}
