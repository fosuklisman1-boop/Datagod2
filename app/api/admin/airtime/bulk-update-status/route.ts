import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { sendSMS } from "@/lib/sms-service"

export async function POST(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const supabase = createClient(supabaseUrl, serviceRoleKey)

    const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse || NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const { orderIds, status, notes } = await request.json()
    if (!orderIds || !Array.isArray(orderIds) || !["completed", "failed"].includes(status)) {
      return NextResponse.json({ error: "orderIds list and status (completed|failed) are required" }, { status: 400 })
    }

    console.log(`[AIRTIME-BULK-ACTION] Admin ${userId} updating ${orderIds.length} orders to ${status}`)

    // Fetch all orders with user info
    const { data: orders, error: fetchError } = await supabase
      .from("airtime_orders")
      .select("*, users!airtime_orders_user_id_fkey_public(email)")
      .in("id", orderIds)

    if (fetchError || !orders) {
      return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
    }

    const results = {
      updated: 0,
      skipped: 0,
      errors: [] as string[]
    }

    // Process each order (simpler to do sequentially or in small parallel batches to avoid overloading)
    for (const order of orders) {
      if (order.status === "completed" || order.status === "failed") {
        results.skipped++
        continue
      }

      try {
        // 1. Update status
        const { error: updateError } = await supabase
          .from("airtime_orders")
          .update({ status, notes: notes || `Bulk update to ${status}` })
          .eq("id", order.id)

        if (updateError) throw updateError

        // 2. Handle failure (Refunding)
        if (status === "failed") {
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

            // Ledger entry
            await supabase.from("transactions").insert([{
              user_id: order.user_id,
              type: "credit",
              source: "airtime_refund",
              amount: order.total_paid,
              balance_before: wallet.balance,
              balance_after: newBalance,
              description: `Bulk Airtime refund: ${order.reference_code}`,
              reference_id: order.id,
              status: "completed",
            }])
          }

          // Notify
          await supabase.from("notifications").insert([{
            user_id: order.user_id,
            title: "Order Failed — Refunded",
            message: `Your airtime order ${order.reference_code} could not be fulfilled. GHS ${order.total_paid} has been refunded.`,
            type: "order_update",
            reference_id: order.id,
            read: false,
          }])

          // SMS (best effort)
          sendSMS({
            phone: order.beneficiary_phone,
            message: `Your order ${order.reference_code} failed. GHS ${order.total_paid} has been refunded.`,
            type: "airtime_failed",
            reference: order.id,
          }).catch(() => {})
        }

        // 3. Handle success (Commission Disbursement)
        if (status === "completed") {
           // If flagged, disburse now. If not flagged, it was likely already disbursed at payment time.
           // However, to be safe and consistent with bulk management, we follow the action logic.
           if (order.is_flagged && order.shop_id && order.merchant_commission > 0) {
             try {
               await supabase.from("shop_profits").insert([{
                 shop_id: order.shop_id,
                 airtime_order_id: order.id,
                 profit_amount: order.merchant_commission,
                 status: "credited",
               }])
             } catch (e) {
               console.warn(`[AIRTIME-BULK-ACTION] Potential duplicate profit for ${order.id}`)
             }
           }

           // Notify
           await supabase.from("notifications").insert([{
            user_id: order.user_id,
            title: "Airtime Delivered!",
            message: `GHS ${order.airtime_amount} airtime has been sent. Ref: ${order.reference_code}`,
            type: "order_update",
            reference_id: order.id,
            read: false,
          }])

          sendSMS({
            phone: order.beneficiary_phone,
            message: `GHS ${order.airtime_amount} airtime has been delivered. Ref: ${order.reference_code}.`,
            type: "airtime_completed",
            reference: order.id,
          }).catch(() => {})
        }

        results.updated++
      } catch (err) {
        console.error(`Error processing bulk update for order ${order.id}:`, err)
        results.errors.push(order.id)
      }
    }

    return NextResponse.json({ 
      success: true, 
      ...results,
      message: `Updated ${results.updated} orders, skipped ${results.skipped}, ${results.errors.length} errors.` 
    })

  } catch (error) {
    console.error("[AIRTIME-BULK-UPDATE] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
