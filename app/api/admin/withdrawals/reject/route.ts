import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { notificationTemplates } from "@/lib/notification-service"
import { sendSMS } from "@/lib/sms-service"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { withdrawalId, reason } = await request.json()

    if (!withdrawalId) {
      return NextResponse.json({ error: "Withdrawal ID required" }, { status: 400 })
    }

    // Get the withdrawal request
    const { data: withdrawal, error: fetchError } = await supabase
      .from("withdrawal_requests")
      .select("id, shop_id, amount, status, user_id, account_details, withdrawal_method")
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
            .select("phone_number, email, first_name")
            .eq("id", shop.user_id)
            .single()

          if (!userError && userData) {
            // Send Email
            if (userData.email) {
              import("@/lib/email-service").then(({ sendEmail, EmailTemplates }) => {
                // Extract payment method and phone from account_details
                const accountDetails = withdrawal.account_details as any;
                // Use withdrawal_method field if available, otherwise extract from account_details
                const paymentMethod = withdrawal.withdrawal_method || accountDetails?.network || "Mobile Money";
                const recipientPhone = accountDetails?.account_number || userData.phone_number;

                // Get current balance (rejection doesn't change it)
                supabase
                  .from("shop_balances")
                  .select("available_balance")
                  .eq("shop_id", withdrawal.shop_id)
                  .single()
                  .then(({ data: balanceData }) => {
                    const remainingBalance = balanceData?.available_balance?.toFixed(2);

                    const payload = EmailTemplates.withdrawalRejected(
                      withdrawal.amount.toFixed(2),
                      remainingBalance,
                      paymentMethod,
                      recipientPhone,
                      reason || "No reason provided"
                    );

                    sendEmail({
                      to: [{ email: userData.email, name: userData.first_name || "Merchant" }],
                      subject: payload.subject,
                      htmlContent: payload.html,
                      referenceId: withdrawalId,
                      userId: shop.user_id,
                      type: 'withdrawal_rejected'
                    }).catch(err => {
                      console.error("[EMAIL] ❌ Withdrawal Rejection Email FAILED:", err)
                      console.error("[EMAIL] Error message:", err?.message)
                      console.error("[EMAIL] Error stack:", err?.stack)
                      console.error("[EMAIL] Full error:", JSON.stringify(err, null, 2))
                    });
                  });
              });
            }

            if (userData.phone_number) {
              const reasonText = reason ? ` Reason: ${reason}` : ""
              const smsMessage = `Your withdrawal request of GHS ${withdrawal.amount.toFixed(2)} has been rejected.${reasonText} Contact support for assistance.`

              await sendSMS({
                phone: userData.phone_number,
                message: smsMessage,
                type: 'withdrawal_rejected',
                reference: withdrawalId,
              }).catch(err => console.error("[SMS] SMS error:", err))
            }
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

    // Sync available balance after rejection (paginated, upsert to avoid race conditions)
    try {
      let allProfits: any[] = []
      let profitOffset = 0
      while (true) {
        const { data: batch, error } = await supabase
          .from("shop_profits")
          .select("profit_amount, status")
          .eq("shop_id", withdrawal.shop_id)
          .range(profitOffset, profitOffset + 999)
        if (error) throw error
        if (!batch || batch.length === 0) break
        allProfits = allProfits.concat(batch)
        if (batch.length < 1000) break
        profitOffset += 1000
      }

      const breakdown = { totalProfit: 0, creditedProfit: 0, withdrawnProfit: 0 }
      allProfits.forEach((p: any) => {
        const amount = p.profit_amount || 0
        breakdown.totalProfit += amount
        if (p.status === "credited")  breakdown.creditedProfit  += amount
        if (p.status === "withdrawn") breakdown.withdrawnProfit += amount
      })

      // Get approved withdrawals (rejected one is no longer counted — status is now "rejected")
      let allApproved: any[] = []
      let wOffset = 0
      while (true) {
        const { data: batch, error } = await supabase
          .from("withdrawal_requests")
          .select("amount")
          .eq("shop_id", withdrawal.shop_id)
          .eq("status", "approved")
          .range(wOffset, wOffset + 999)
        if (error) break
        if (!batch || batch.length === 0) break
        allApproved = allApproved.concat(batch)
        if (batch.length < 1000) break
        wOffset += 1000
      }
      const totalApprovedWithdrawals = allApproved.reduce((s, w) => s + (w.amount || 0), 0)

      const availableBalance = Math.max(0, breakdown.creditedProfit - totalApprovedWithdrawals)

      const { error: upsertError } = await supabase
        .from("shop_available_balance")
        .upsert(
          {
            shop_id: withdrawal.shop_id,
            available_balance: availableBalance,
            total_profit: breakdown.totalProfit,
            withdrawn_amount: breakdown.withdrawnProfit,
            credited_profit: breakdown.creditedProfit,
            withdrawn_profit: breakdown.withdrawnProfit,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "shop_id" }
        )

      if (upsertError) {
        console.error(`[WITHDRAWAL-REJECT] Balance upsert failed:`, upsertError)
      } else {
        console.log(`[WITHDRAWAL-REJECT] Balance restored for shop: ${withdrawal.shop_id} - Available: GHS ${availableBalance.toFixed(2)}`)
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
