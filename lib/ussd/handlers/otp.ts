import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { UzoResponse } from "../types"
import { submitOtp } from "../../paystack"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export type OtpOrderTable = "airtime_orders" | "results_checker_orders"

// Both airtime_orders and results_checker_orders carry a `status` column (the
// data-bundle tables use `order_status` instead — those keep their own OTP
// handlers). The "awaiting prompt" payment_status they sit at before a charge
// confirms is 'pending_payment'.
const SECONDARY_STATUS_COL = "status"
const PENDING_VALUE = "pending_payment"

/**
 * Shared OTP-submission step for USSD airtime / results-checker orders (both the
 * main and white-label menus). The Paystack reference IS the order UUID, so
 * `submitOtp(orderId, otp)` completes the charge regardless of table; the table
 * is only needed to flip the order's status on cancel/failure.
 */
export async function handleOtpSubmit(
  input: string,
  orderId: string,
  table: OtpOrderTable
): Promise<UzoResponse> {
  if (input.trim() === "0") {
    await supabase
      .from(table)
      .update({ payment_status: "failed", [SECONDARY_STATUS_COL]: "failed", updated_at: new Date().toISOString() })
      .eq("id", orderId)
    return { message: "Order cancelled.", ussdServiceOp: 17 }
  }

  const otp = input.trim()

  // Flip out of 'otp_required' before the session closes so a quick redial does
  // not re-trigger the OTP prompt while the charge is being completed.
  await supabase
    .from(table)
    .update({ payment_status: PENDING_VALUE, updated_at: new Date().toISOString() })
    .eq("id", orderId)

  after(async () => {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const { status } = await submitOtp(orderId, otp)
      console.log("[USSD-OTP] submitOtp status:", status, "order:", orderId, "table:", table)
      if (status === "failed") {
        await supabase
          .from(table)
          .update({ payment_status: "failed", [SECONDARY_STATUS_COL]: "failed", updated_at: new Date().toISOString() })
          .eq("id", orderId)
      }
    } catch (err) {
      console.error("[USSD-OTP] submitOtp error:", err)
      await supabase
        .from(table)
        .update({ payment_status: "failed", [SECONDARY_STATUS_COL]: "failed", updated_at: new Date().toISOString() })
        .eq("id", orderId)
    }
  })

  return {
    message: "Check your phone for\na MoMo authorization\nprompt and approve\nto complete payment.",
    ussdServiceOp: 17,
  }
}
