import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { sendSMS } from "@/lib/sms-service"
import { verifyAdminAccess } from "@/lib/admin-auth"

export async function POST(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const supabase = createClient(supabaseUrl, serviceRoleKey)

    const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse || NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const { orderId, action, notes } = await request.json()
    if (!orderId || !["completed", "failed"].includes(action)) {
      return NextResponse.json({ error: "orderId and action (completed|failed) are required" }, { status: 400 })
    }

    // Fetch the order
    const { data: order, error: fetchError } = await supabase
      .from("airtime_orders")
      .select("*, users!airtime_orders_user_id_fkey_public(email)")
      .eq("id", orderId)
      .single()

    if (fetchError || !order) {
      console.error("[AIRTIME-ACTION] Order fetch failed:", fetchError)
      return NextResponse.json({ error: "Order not found in database" }, { status: 404 })
    }

    if (order.status === "completed" || order.status === "failed") {
      return NextResponse.json({ error: `Order is already ${order.status}` }, { status: 409 })
    }

    // Update the order status
    const { error: updateError } = await supabase
      .from("airtime_orders")
      .update({ status: action, notes: notes || null })
      .eq("id", orderId)

    if (updateError) throw updateError

    // If FAILED → refund the wallet
    if (action === "failed") {
      // Re-credit wallet
      const { data: wallet } = await supabase
        .from("wallets")
        .select("balance, total_spent")
        .eq("user_id", order.user_id)
        .single()

      if (wallet) {
        const newBalance = (wallet.balance || 0) + order.total_paid
        const newTotalSpent = Math.max(0, (wallet.total_spent || 0) - order.total_paid)

        await supabase
          .from("wallets")
          .update({ balance: newBalance, total_spent: newTotalSpent, updated_at: new Date().toISOString() })
          .eq("user_id", order.user_id)

        // Ledger entry for the refund
        await supabase.from("transactions").insert([{
          user_id: order.user_id,
          type: "credit",
          source: "airtime_refund",
          amount: order.total_paid,
          balance_before: wallet.balance,
          balance_after: newBalance,
          description: `Airtime refund: ${order.reference_code} — ${order.network} to ${order.beneficiary_phone}`,
          reference_id: order.id,
          status: "completed",
          created_at: new Date().toISOString(),
        }])
      }

      // Notify user of refund
      await supabase.from("notifications").insert([{
        user_id: order.user_id,
        title: "Airtime Order Failed — Refunded",
        message: `Your airtime order ${order.reference_code} could not be fulfilled. GHS ${order.total_paid} has been refunded to your wallet.`,
        type: "order_update",
        reference_id: order.id,
        action_url: `/dashboard/airtime`,
        read: false,
      }])

      // Non-blocking SMS to user
      sendSMS({
        phone: order.beneficiary_phone,
        message: `Your airtime order ${order.reference_code} failed. GHS ${order.total_paid} has been refunded to your wallet.`,
        type: "airtime_failed",
        reference: order.id,
      }).catch(e => console.warn("[AIRTIME-ACTION] Refund SMS error:", e))

      // Non-blocking email to user
      import("@/lib/email-service").then(({ sendEmail, EmailTemplates }) => {
        const p = EmailTemplates.airtimeOrderFailed(order.reference_code, notes || "Order could not be fulfilled")
        if (order.users?.email) {
          return sendEmail({
            to: [{ email: order.users.email }],
            subject: p.subject,
            htmlContent: p.html,
            referenceId: order.id,
            type: "airtime_failed",
          })
        }
      }).catch(e => console.warn("[AIRTIME-ACTION] Refund email error:", e))

      // 3. Reverse Merchant Commission (if any was disbursed at payment time)
      if (order.shop_id && order.merchant_commission > 0) {
        console.log(`[AIRTIME-ACTION] Order ${order.reference_code} failed. Reversing merchant commission...`)
        
        // Mark the profit record as failed
        const { error: revError } = await supabase
          .from("shop_profits")
          .update({ status: "failed", updated_at: new Date().toISOString() })
          .eq("airtime_order_id", order.id)
        
        if (!revError) {
          // Sync shop balance
          try {
            const { data: shop } = await supabase.from("user_shops").select("id").eq("id", order.shop_id).single()
            if (shop) {
              // Simple balance sync trigger
              const { data: profits } = await supabase.from("shop_profits").select("profit_amount").eq("shop_id", order.shop_id).eq("status", "credited")
              const { data: withdrawals } = await supabase.from("withdrawal_requests").select("amount").eq("shop_id", order.shop_id).eq("status", "approved")
              
              const totalProfits = profits?.reduce((sum, p) => sum + (p.profit_amount || 0), 0) || 0
              const totalWithdrawals = withdrawals?.reduce((sum, w) => sum + (w.amount || 0), 0) || 0
              const availableBalance = Math.max(0, totalProfits - totalWithdrawals)

              await supabase.from("shop_available_balance").update({ 
                available_balance: availableBalance, 
                credited_profit: totalProfits, 
                updated_at: new Date().toISOString() 
              }).eq("shop_id", order.shop_id)
              console.log(`[AIRTIME-ACTION] ✓ Shop balance resynced after commission reversal.`)
            }
          } catch (syncError) {
            console.error("[AIRTIME-ACTION] Failed to sync balance after reversal:", syncError)
          }
        }
      }
    }

    // If COMPLETED → notify user of delivery & pay merchant commission
    if (action === "completed") {
      // 1. Profit Handling
      // - If order was NOT flagged, profit was already handled at payment verification time (Guest Purchases)
      // - If order WAS flagged, we disburse profit NOW (Manual Completion Override)
      // - Wallet purchases are always profit-free
      
      if (order.is_flagged && order.shop_id && order.merchant_commission > 0) {
        console.log(`[AIRTIME-ACTION] Flagged order ${order.reference_code} completed. Disbursing commission manually now...`)
        
        // 1. Create profit record
        const { error: profitError } = await supabase
          .from("shop_profits")
          .insert([{
            shop_id: order.shop_id,
            airtime_order_id: order.id,
            profit_amount: order.merchant_commission,
            status: "credited",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }])
        
        if (!profitError) {
          // 2. Sync shop balance
          try {
            const { data: profits } = await supabase.from("shop_profits").select("profit_amount").eq("shop_id", order.shop_id).eq("status", "credited")
            const { data: withdrawals } = await supabase.from("withdrawal_requests").select("amount").eq("shop_id", order.shop_id).eq("status", "approved")
            
            const totalProfits = profits?.reduce((sum, p) => sum + (p.profit_amount || 0), 0) || 0
            const totalWithdrawals = withdrawals?.reduce((sum, w) => sum + (w.amount || 0), 0) || 0
            const availableBalance = Math.max(0, totalProfits - totalWithdrawals)

            await supabase.from("shop_available_balance").update({ 
              available_balance: availableBalance, 
              credited_profit: totalProfits, 
              updated_at: new Date().toISOString() 
            }).eq("shop_id", order.shop_id)
            console.log(`[AIRTIME-ACTION] ✓ Shop balance resynced after manual flagged order disbursement.`)
          } catch (syncError) {
            console.error("[AIRTIME-ACTION] Failed to sync balance after manual disbursement:", syncError)
          }
        }
      }

      await supabase.from("notifications").insert([{
        user_id: order.user_id,
        title: "Airtime Delivered!",
        message: `GHS ${order.airtime_amount} ${order.network} airtime has been sent to ${order.beneficiary_phone}. Ref: ${order.reference_code}`,
        type: "order_update",
        reference_id: order.id,
        action_url: `/dashboard/airtime`,
        read: false,
      }])

      sendSMS({
        phone: order.beneficiary_phone,
        message: `GHS ${order.airtime_amount} ${order.network} airtime has been sent to ${order.beneficiary_phone}. Ref: ${order.reference_code}.`,
        type: "airtime_completed",
        reference: order.id,
      }).catch(e => console.warn("[AIRTIME-ACTION] Delivered SMS error:", e))

      import("@/lib/email-service").then(({ sendEmail, EmailTemplates }) => {
        const p = EmailTemplates.airtimePurchaseConfirmed(order.reference_code, order.network, order.airtime_amount.toFixed(2), order.total_paid.toFixed(2))
        if (order.users?.email) {
          return sendEmail({
            to: [{ email: order.users.email }],
            subject: p.subject,
            htmlContent: p.html,
            referenceId: order.id,
            type: "airtime_completed",
          })
        }
      }).catch(e => console.warn("[AIRTIME-ACTION] Delivered email error:", e))
    }

    console.log(`[AIRTIME-ACTION] Admin ${userId} marked order ${order.reference_code} as ${action}`)

    return NextResponse.json({ success: true, action, orderId })
  } catch (error) {
    console.error("[AIRTIME-ACTION] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
