import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { notificationTemplates } from "@/lib/notification-service"
import { sendSMS } from "@/lib/sms-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { withdrawalId, reason } = await request.json()

    if (!withdrawalId) {
      return NextResponse.json({ error: "Withdrawal ID required" }, { status: 400 })
    }

    // Get the withdrawal request
    const { data: withdrawal, error: fetchError } = await supabase
      .from("withdrawal_requests")
      .select("*")
      .eq("id", withdrawalId)
      .single()

    if (fetchError || !withdrawal) {
      return NextResponse.json({ error: "Withdrawal not found" }, { status: 404 })
    }

    // Update withdrawal status to rejected with reason
    const { error: updateError } = await supabase
      .from("withdrawal_requests")
      .update({
        status: "rejected",
        rejection_reason: reason || "No reason provided",
        updated_at: new Date().toISOString(),
      })
      .eq("id", withdrawalId)

    if (updateError) {
      throw new Error(`Failed to update withdrawal: ${updateError.message}`)
    }

    console.log(`[WITHDRAWAL-REJECT] Withdrawal ${withdrawalId} rejected - Amount: GHS ${withdrawal.amount}`)

    // Send notification to shop owner via admin API endpoint
    try {
      // Get shop owner user_id
      const { data: shop, error: shopError } = await supabase
        .from("user_shops")
        .select("user_id")
        .eq("id", withdrawal.shop_id)
        .single()

      if (!shopError && shop) {
        try {
          const notificationData = notificationTemplates.withdrawalRejected(withdrawalId, reason || "No reason provided")
          const { error: notifError } = await supabase
            .from("notifications")
            .insert([
              {
                user_id: shop.user_id,
                title: notificationData.title,
                message: notificationData.message,
                type: notificationData.type,
                reference_id: notificationData.reference_id,
                action_url: `/dashboard/shop-dashboard`,
                read: false,
              },
            ])
          if (notifError) {
            console.warn("[NOTIFICATION] Failed to send notification:", notifError)
          } else {
            console.log(`[NOTIFICATION] Withdrawal rejection notification sent to user ${shop.user_id}`)
          }
        } catch (notifError) {
          console.warn("[NOTIFICATION] Failed to send notification:", notifError)
        }

        // Send SMS to shop owner
        try {
          const { data: userData, error: userError } = await supabase
            .from("users")
            .select("phone_number")
            .eq("id", shop.user_id)
            .single()

          if (!userError && userData?.phone_number) {
            const reasonText = reason ? ` Reason: ${reason}` : ""
            const smsMessage = `Your withdrawal request of GHS ${withdrawal.amount.toFixed(2)} has been rejected.${reasonText} Contact support for assistance.`
            
            await sendSMS({
              phone: userData.phone_number,
              message: smsMessage,
              type: 'withdrawal_rejected',
              reference: withdrawalId,
            }).catch(err => console.error("[SMS] SMS error:", err))
          }
        } catch (smsError) {
          console.warn("[SMS] Failed to send withdrawal rejection SMS:", smsError)
          // Don't fail the rejection if SMS fails
        }
      }
    } catch (notifError) {
      console.warn("[NOTIFICATION] Failed to send notification:", notifError)
      // Don't fail the rejection if notification fails
    }

    // Sync available balance after rejection (restores the balance since withdrawal is no longer pending)
    try {
      const { data: profits, error: profitError } = await supabase
        .from("shop_profits")
        .select("profit_amount, status")
        .eq("shop_id", withdrawal.shop_id)

      if (!profitError && profits) {
        // Calculate totals by status
        const breakdown = {
          totalProfit: 0,
          creditedProfit: 0,
          withdrawnProfit: 0,
        }

        profits.forEach((p: any) => {
          const amount = p.profit_amount || 0
          breakdown.totalProfit += amount

          if (p.status === "credited") {
            breakdown.creditedProfit += amount
          } else if (p.status === "withdrawn") {
            breakdown.withdrawnProfit += amount
          }
        })

        // Get approved withdrawals (this one is now rejected, so won't be counted)
        const { data: approvedWithdrawals, error: withdrawalError } = await supabase
          .from("withdrawal_requests")
          .select("amount")
          .eq("shop_id", withdrawal.shop_id)
          .eq("status", "approved")

        let totalApprovedWithdrawals = 0
        if (!withdrawalError && approvedWithdrawals) {
          totalApprovedWithdrawals = approvedWithdrawals.reduce((sum, w) => sum + (w.amount || 0), 0)
        }

        // Available balance = credited profit - approved withdrawals
        const availableBalance = Math.max(0, breakdown.creditedProfit - totalApprovedWithdrawals)

        // Delete and insert fresh balance record
        const deleteResult = await supabase
          .from("shop_available_balance")
          .delete()
          .eq("shop_id", withdrawal.shop_id)

        if (deleteResult.error) {
          console.warn(`[WITHDRAWAL-REJECT] Warning deleting old balance:`, deleteResult.error)
        }

        const { error: insertError } = await supabase
          .from("shop_available_balance")
          .insert([{
            shop_id: withdrawal.shop_id,
            available_balance: availableBalance,
            total_profit: breakdown.totalProfit,
            withdrawn_amount: breakdown.withdrawnProfit,
            credited_profit: breakdown.creditedProfit,
            withdrawn_profit: breakdown.withdrawnProfit,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }])

        if (insertError) {
          console.error(`[WITHDRAWAL-REJECT] Error inserting balance:`, insertError)
        } else {
          console.log(`[WITHDRAWAL-REJECT] Balance restored for shop: ${withdrawal.shop_id} - Available: GHS ${availableBalance.toFixed(2)}`)
        }
      }
    } catch (syncError) {
      console.warn(`[WITHDRAWAL-REJECT] Warning restoring balance:`, syncError)
    }

    return NextResponse.json({
      success: true,
      message: "Withdrawal rejected successfully",
    })
  } catch (error) {
    console.error("[WITHDRAWAL-REJECT] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
