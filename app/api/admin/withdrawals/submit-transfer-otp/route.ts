import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { finalizeTransfer } from "@/lib/paystack-transfer"
import { notificationTemplates } from "@/lib/notification-service"
import { sendSMS } from "@/lib/sms-service"
import { sendPushToUser } from "@/lib/push-service"

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

async function notifyShopOwner(shopId: string, amount: number, withdrawalId: string) {
  try {
    const { data: shop } = await supabase.from("user_shops").select("user_id").eq("id", shopId).single()
    if (!shop) return
    const notificationData = notificationTemplates.withdrawalApproved(amount, withdrawalId)
    await supabase.from("notifications").insert([{
      user_id: shop.user_id,
      title: notificationData.title,
      message: notificationData.message,
      type: notificationData.type,
      reference_id: notificationData.reference_id,
      action_url: "/dashboard/shop-dashboard",
      read: false,
    }])
    sendPushToUser(shop.user_id, {
      title: notificationData.title,
      body: notificationData.message,
      data: { url: "/dashboard/shop-dashboard" },
    }).catch(() => {})

    const { data: userData } = await supabase.from("users").select("phone_number").eq("id", shop.user_id).single()
    if (userData?.phone_number) {
      await sendSMS({
        phone: userData.phone_number,
        message: `✓ Your withdrawal of GHS ${amount.toFixed(2)} has been transferred.`,
        type: "withdrawal_approved",
        reference: withdrawalId,
      }).catch(() => {})
    }
  } catch (err) {
    console.warn("[SUBMIT-TRANSFER-OTP] Notification error (non-fatal):", err)
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
      .select("id, shop_id, amount, paystack_transfer_code, status")
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

    // "success" or "pending" — Paystack accepted the OTP; the transfer.success
    // webhook (Task 7) is the authoritative completion signal for "pending",
    // but mark completed immediately on "success" for the same UX as Moolre.
    await supabase
      .from("withdrawal_requests")
      .update({
        status: result.status === "success" ? "completed" : "processing",
        paystack_fee: result.fee,
        transfer_completed_at: result.status === "success" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", withdrawalId)

    if (result.status === "success") {
      await syncShopBalance(withdrawal.shop_id)
      await notifyShopOwner(withdrawal.shop_id, Number(withdrawal.amount), withdrawalId)
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
