import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getTransferStatus } from "@/lib/moolre-transfer"
import { notificationTemplates } from "@/lib/notification-service"
import { sendSMS } from "@/lib/sms-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function syncShopBalance(shopId: string) {
  const { data: profits } = await supabase
    .from("shop_profits")
    .select("profit_amount, status")
    .eq("shop_id", shopId)

  if (!profits) return

  let creditedProfit = 0
  let totalProfit = 0
  let withdrawnProfit = 0

  profits.forEach((p: any) => {
    const amount = p.profit_amount || 0
    totalProfit += amount
    if (p.status === "credited") creditedProfit += amount
    else if (p.status === "withdrawn") withdrawnProfit += amount
  })

  const { data: completedWithdrawals } = await supabase
    .from("withdrawal_requests")
    .select("amount")
    .eq("shop_id", shopId)
    .in("status", ["completed", "approved"])

  const totalCompleted = (completedWithdrawals || []).reduce(
    (sum: number, w: any) => sum + (w.amount || 0),
    0
  )

  const availableBalance = Math.max(0, creditedProfit - totalCompleted)

  await supabase.from("shop_available_balance").delete().eq("shop_id", shopId)
  await supabase.from("shop_available_balance").insert([{
    shop_id: shopId,
    available_balance: availableBalance,
    total_profit: totalProfit,
    withdrawn_amount: withdrawnProfit,
    credited_profit: creditedProfit,
    withdrawn_profit: withdrawnProfit,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }])
}

async function notifyCompletion(withdrawal: any) {
  try {
    const { data: shop } = await supabase
      .from("user_shops")
      .select("user_id")
      .eq("id", withdrawal.shop_id)
      .single()

    if (!shop) return

    const notificationData = notificationTemplates.withdrawalApproved(withdrawal.amount, withdrawal.id)
    await supabase.from("notifications").insert([{
      user_id: shop.user_id,
      title: notificationData.title,
      message: notificationData.message,
      type: notificationData.type,
      reference_id: notificationData.reference_id,
      action_url: `/dashboard/shop-dashboard`,
      read: false,
    }]).catch(err => console.warn("[CRON-NOTIFY] Notification error:", err))

    const { data: userData } = await supabase
      .from("users")
      .select("phone_number")
      .eq("id", shop.user_id)
      .single()

    if (userData?.phone_number) {
      const accountDetails = withdrawal.account_details as any
      const smsMessage = `✓ Your withdrawal of GHS ${withdrawal.amount.toFixed(2)} has been transferred to ${accountDetails?.phone || "your account"}.`
      await sendSMS({
        phone: userData.phone_number,
        message: smsMessage,
        type: "withdrawal_approved",
        reference: withdrawal.id,
      }).catch(err => console.error("[CRON-SMS] Error:", err))
    }
  } catch (err) {
    console.warn("[CRON-NOTIFY] Non-fatal error:", err)
  }
}

export async function GET(request: NextRequest) {
  // Secure cron endpoint — Vercel sends Authorization: Bearer <CRON_SECRET>
  const authHeader = request.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    // Fetch all withdrawals in "processing" state that have a Moolre reference
    const { data: processingWithdrawals, error } = await supabase
      .from("withdrawal_requests")
      .select("id, shop_id, amount, account_details, moolre_external_ref, moolre_transfer_id")
      .eq("status", "processing")
      .not("moolre_external_ref", "is", null)

    if (error) {
      console.error("[CRON-STATUS] Fetch error:", error)
      return NextResponse.json({ error: "Failed to fetch processing withdrawals" }, { status: 500 })
    }

    if (!processingWithdrawals || processingWithdrawals.length === 0) {
      return NextResponse.json({ processed: 0, completed: 0, failed: 0, pending: 0 })
    }

    let completed = 0
    let failed = 0
    let pending = 0

    for (const withdrawal of processingWithdrawals) {
      const statusResult = await getTransferStatus(withdrawal.moolre_external_ref)

      if (!statusResult) {
        console.warn(`[CRON-STATUS] Could not reach Moolre for withdrawal ${withdrawal.id}`)
        pending++
        continue
      }

      if (statusResult.txstatus === 1) {
        // Transfer confirmed — complete it and sync balance
        await supabase
          .from("withdrawal_requests")
          .update({
            status: "completed",
            moolre_transfer_id: statusResult.transactionId || withdrawal.moolre_transfer_id,
            transfer_completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", withdrawal.id)

        await syncShopBalance(withdrawal.shop_id)
        await notifyCompletion(withdrawal)

        console.log(`[CRON-STATUS] Completed: ${withdrawal.id} — TX: ${statusResult.transactionId}`)
        completed++
      } else if (statusResult.txstatus === 2) {
        // Transfer failed — mark failed, do NOT deduct balance
        await supabase
          .from("withdrawal_requests")
          .update({
            status: "failed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", withdrawal.id)

        console.error(`[CRON-STATUS] Failed: ${withdrawal.id}`)
        failed++
      } else {
        // txstatus=0 (still pending) or txstatus=3 (unknown) — check again next run
        pending++
      }
    }

    const summary = {
      processed: processingWithdrawals.length,
      completed,
      failed,
      pending,
    }

    console.log("[CRON-STATUS] Run complete:", summary)
    return NextResponse.json(summary)
  } catch (error) {
    console.error("[CRON-STATUS] Internal error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
