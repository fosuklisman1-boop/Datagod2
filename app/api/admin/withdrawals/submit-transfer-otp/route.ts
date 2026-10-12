import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { finalizeTransfer } from "@/lib/paystack-transfer"
import { notifyWithdrawalCompleted } from "@/lib/admin-actions/withdrawal-hook"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function syncShopBalance(shopId: string) {
  try {
    const { data: breakdown } = await supabase.rpc("get_shop_balance_breakdown", { p_shop_id: shopId })
    if (!breakdown) return
    const creditedProfit = Number(breakdown.credited_p) || 0
    const totalWithdrawn = Number(breakdown.total_w) || 0
    await supabase.from("shop_available_balance").upsert({
      shop_id: shopId,
      available_balance: creditedProfit - totalWithdrawn,
      total_profit: Number(breakdown.total_p) || 0,
      withdrawn_amount: totalWithdrawn,
      credited_profit: creditedProfit,
      withdrawn_profit: Number(breakdown.withdrawn_p) || 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: "shop_id" })
  } catch (err) {
    console.error("[SUBMIT-TRANSFER-OTP] Balance sync error:", err)
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { withdrawalId, otp } = await request.json()
    if (!withdrawalId || typeof withdrawalId !== "string" || !otp || typeof otp !== "string") {
      return NextResponse.json({ error: "withdrawalId and otp are required" }, { status: 400 })
    }

    const { data: withdrawal, error: fetchError } = await supabase
      .from("withdrawal_requests")
      .select("id, shop_id, amount, paystack_transfer_code, status, withdrawal_method, account_details")
      .eq("id", withdrawalId)
      .maybeSingle()

    if (fetchError || !withdrawal) {
      return NextResponse.json({ error: "Withdrawal not found" }, { status: 404 })
    }
    if (withdrawal.status !== "awaiting_transfer_otp" || !withdrawal.paystack_transfer_code) {
      return NextResponse.json({ error: `Withdrawal is not awaiting an OTP (status: ${withdrawal.status})` }, { status: 400 })
    }

    const result = await finalizeTransfer(withdrawal.paystack_transfer_code, otp)

    if (!result) {
      return NextResponse.json({ error: "Could not reach Paystack. Please try again." }, { status: 503 })
    }

    if (result.status === "failed") {
      return NextResponse.json({ error: result.errorMessage || "That code was rejected. Please try again." }, { status: 400 })
    }

    if (result.status !== "success" && result.status !== "pending") {
      console.error("[SUBMIT-TRANSFER-OTP] Unexpected Paystack status after finalize:", result.status)
      return NextResponse.json({ error: "Unexpected response from Paystack. Please contact support before retrying." }, { status: 502 })
    }

    // "success" or "pending" — Paystack accepted the OTP; the transfer.success
    // webhook (Task 7) is the authoritative completion signal for "pending",
    // but mark completed immediately on "success" for the same UX as Moolre.
    const { data: flippedRows } = await supabase
      .from("withdrawal_requests")
      .update({
        status: result.status === "success" ? "completed" : "processing",
        paystack_fee: result.fee,
        transfer_completed_at: result.status === "success" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", withdrawalId)
      .eq("status", "awaiting_transfer_otp")
      .select("id")

    if (result.status === "success") {
      await syncShopBalance(withdrawal.shop_id)
      // Notify only if this call actually moved the row into "completed" (the webhook may have got there first)
      if (flippedRows && flippedRows.length > 0) {
        await notifyWithdrawalCompleted(supabase, withdrawal)
      }
    }

    return NextResponse.json({ success: true, status: result.status === "success" ? "completed" : "processing" })
  } catch (error) {
    console.error("[SUBMIT-TRANSFER-OTP] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
