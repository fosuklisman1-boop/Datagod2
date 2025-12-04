import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { notificationService, notificationTemplates } from "@/lib/notification-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { withdrawalId } = await request.json()

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

    // Get all pending withdrawal requests BEFORE changing status (so we include this one)
    const { data: pendingWithdrawalsBeforeUpdate, error: withdrawalCheckError } = await supabase
      .from("withdrawal_requests")
      .select("amount")
      .eq("shop_id", withdrawal.shop_id)
      .eq("status", "pending")

    let totalPendingWithdrawalsBeforeUpdate = 0
    if (!withdrawalCheckError && pendingWithdrawalsBeforeUpdate) {
      totalPendingWithdrawalsBeforeUpdate = pendingWithdrawalsBeforeUpdate.reduce((sum, w) => sum + (w.amount || 0), 0)
    }

    // Update withdrawal status to approved
    const { error: updateError } = await supabase
      .from("withdrawal_requests")
      .update({
        status: "approved",
        updated_at: new Date().toISOString(),
      })
      .eq("id", withdrawalId)

    if (updateError) {
      throw new Error(`Failed to update withdrawal: ${updateError.message}`)
    }

    console.log(`[WITHDRAWAL-APPROVE] Withdrawal ${withdrawalId} approved - Amount: GHS ${withdrawal.amount}`)

    // Send notification to shop owner
    try {
      // Get shop owner user_id
      const { data: shop, error: shopError } = await supabase
        .from("user_shops")
        .select("user_id")
        .eq("id", withdrawal.shop_id)
        .single()

      if (!shopError && shop) {
        const notificationData = notificationTemplates.withdrawalApproved(withdrawal.amount, withdrawalId)
        await notificationService.createNotification(
          shop.user_id,
          notificationData.title,
          notificationData.message,
          notificationData.type,
          {
            reference_id: notificationData.reference_id,
            action_url: `/dashboard/shop-dashboard`,
          }
        )
        console.log(`[NOTIFICATION] Withdrawal approval notification sent to user ${shop.user_id}`)
      }
    } catch (notifError) {
      console.warn("[NOTIFICATION] Failed to send notification:", notifError)
      // Don't fail the approval if notification fails
    }

    // Sync available balance after approval
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

        // Query remaining approved withdrawals (including this one which is now approved)
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
        
        console.log(`[WITHDRAWAL-APPROVE-BALANCE] Shop ${withdrawal.shop_id}:`, {
          creditedProfit: breakdown.creditedProfit,
          totalApprovedWithdrawals,
          calculation: `${breakdown.creditedProfit} - ${totalApprovedWithdrawals}`,
          availableBalance,
          approvedWithdrawalAmount: withdrawal.amount,
        })

        // Delete and insert fresh balance record
        await supabase
          .from("shop_available_balance")
          .delete()
          .eq("shop_id", withdrawal.shop_id)

        await supabase
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

        console.log(`[WITHDRAWAL-APPROVE] Balance synced for shop: ${withdrawal.shop_id} - Available: GHS ${availableBalance.toFixed(2)}`)
      }
    } catch (syncError) {
      console.warn(`[WITHDRAWAL-APPROVE] Warning syncing balance:`, syncError)
    }

    return NextResponse.json({
      success: true,
      message: "Withdrawal approved successfully",
    })
  } catch (error) {
    console.error("[WITHDRAWAL-APPROVE] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
