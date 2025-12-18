import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { type NotificationType } from "@/lib/notification-service"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { orderIds, status } = await request.json()

    if (!orderIds || orderIds.length === 0) {
      return NextResponse.json(
        { error: "No order IDs provided" },
        { status: 400 }
      )
    }

    if (!status) {
      return NextResponse.json(
        { error: "Status is required" },
        { status: 400 }
      )
    }

    console.log(`[SHOP-ORDERS-UPDATE] Updating ${orderIds.length} shop orders to status: ${status}`)

    // Update shop order status
    const { error: updateError } = await supabase
      .from("shop_orders")
      .update({ order_status: status, updated_at: new Date().toISOString() })
      .in("id", orderIds)

    if (updateError) {
      console.error("[SHOP-ORDERS-UPDATE] Error updating shop orders:", updateError)
      throw new Error(`Failed to update shop order status: ${updateError.message}`)
    }

    console.log(`[SHOP-ORDERS-UPDATE] ✓ Updated ${orderIds.length} shop orders to status: ${status}`)

    // Send notifications to users about their order status change
    try {
      const { data: shopOrders, error: ordersError } = await supabase
        .from("shop_orders")
        .select("id, user_id, network, volume_gb, phone_number")
        .in("id", orderIds)

      if (!ordersError && shopOrders && shopOrders.length > 0) {
        // Batch insert all notifications at once instead of looping
        const notifications = shopOrders.map((order) => {
          let title = "Order Updated"
          let message = ""

          if (status === "completed") {
            title = "Order Completed"
            message = `Your ${order.network} ${order.volume_gb}GB data order has been completed. Phone: ${order.phone_number}`
          } else if (status === "processing") {
            title = "Order Processing"
            message = `Your ${order.network} ${order.volume_gb}GB data order is now being processed. Phone: ${order.phone_number}`
          } else if (status === "failed") {
            title = "Order Failed"
            message = `Your ${order.network} ${order.volume_gb}GB data order has failed. Please contact support. Phone: ${order.phone_number}`
          } else {
            title = "Order Status Updated"
            message = `Your order status has been updated to: ${status}. Phone: ${order.phone_number}`
          }

          return {
            user_id: order.user_id,
            title,
            message,
            type: "order_update" as NotificationType,
            reference_id: order.id,
            action_url: `/dashboard/shop-orders`,
            read: false,
          }
        })

        const { error: notifError } = await supabase
          .from("notifications")
          .insert(notifications)

        if (notifError) {
          console.warn(`[SHOP-ORDERS-UPDATE] Failed to send ${notifications.length} notifications:`, notifError)
        } else {
          console.log(`[SHOP-ORDERS-UPDATE] ✓ Sent ${notifications.length} status notifications`)
        }
      }
    } catch (notifError) {
      console.warn("[SHOP-ORDERS-UPDATE] Error sending notifications:", notifError)
    }

    // If status is "completed", credit the associated profits
    if (status === "completed") {
      console.log(`[SHOP-ORDERS-UPDATE] Crediting profits for ${orderIds.length} completed orders...`)

      // Get the profit records for these orders
      const { data: profitRecords, error: profitFetchError } = await supabase
        .from("shop_profits")
        .select("id, shop_id, profit_amount, status")
        .in("shop_order_id", orderIds)
        .eq("status", "pending")

      if (profitFetchError) {
        console.error("[SHOP-ORDERS-UPDATE] Error fetching profit records:", profitFetchError)
        throw new Error(`Failed to fetch profit records: ${profitFetchError.message}`)
      }

      console.log(`[SHOP-ORDERS-UPDATE] Found ${profitRecords?.length || 0} pending profit records`)

      if (profitRecords && profitRecords.length > 0) {
        // Update profit records to "credited"
        const profitIds = profitRecords.map(p => p.id)
        
        // Try to update with updated_at, if column doesn't exist, just update status
        const updatePayload: any = { status: "credited" }
        let profitUpdateError = null
        
        try {
          const result = await supabase
            .from("shop_profits")
            .update({ ...updatePayload, updated_at: new Date().toISOString() })
            .in("id", profitIds)
          profitUpdateError = result.error
        } catch (error) {
          // Try without updated_at if column doesn't exist
          console.warn("[SHOP-ORDERS-UPDATE] updated_at column might not exist, trying without it")
          const result = await supabase
            .from("shop_profits")
            .update(updatePayload)
            .in("id", profitIds)
          profitUpdateError = result.error
        }

        if (profitUpdateError) {
          console.error("[SHOP-ORDERS-UPDATE] Error updating profit records:", profitUpdateError)
          throw new Error(`Failed to update profit records: ${profitUpdateError.message}`)
        }

        console.log(`[SHOP-ORDERS-UPDATE] ✓ Credited ${profitRecords.length} profit records`)

        // Log profit details
        const totalProfit = profitRecords.reduce((sum, p) => sum + p.profit_amount, 0)
        console.log(`[SHOP-ORDERS-UPDATE] Total profit credited: GHS ${totalProfit.toFixed(2)}`)

        // Sync available balance for each shop
        const shopIds = [...new Set(profitRecords.map(p => p.shop_id))]
        
        // Batch fetch all profits and withdrawals for all shops at once
        const [profitsResult, withdrawalsResult] = await Promise.all([
          supabase
            .from("shop_profits")
            .select("shop_id, profit_amount, status")
            .in("shop_id", shopIds),
          supabase
            .from("withdrawal_requests")
            .select("shop_id, amount")
            .in("shop_id", shopIds)
            .eq("status", "approved")
        ])

        const { data: allShopProfits, error: allProfitsError } = profitsResult
        const { data: allApprovedWithdrawals } = withdrawalsResult

        // Process all shops without additional queries
        if (!allProfitsError && allShopProfits) {
          for (const shopId of shopIds) {
            try {
              // Filter profits for this shop from the already-fetched data
              const profits = allShopProfits.filter(p => p.shop_id === shopId)

              if (profits.length > 0) {
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

                // Use already-fetched withdrawals for this shop
                const shopWithdrawals = allApprovedWithdrawals ? allApprovedWithdrawals.filter(w => w.shop_id === shopId) : []
                const totalApprovedWithdrawals = shopWithdrawals.reduce((sum, w) => sum + (w.amount || 0), 0)

              // Available balance = credited profit - approved withdrawals
              const availableBalance = Math.max(0, breakdown.creditedProfit - totalApprovedWithdrawals)

              // Delete existing record and insert fresh (more reliable than upsert)
              const deleteResult = await supabase
                .from("shop_available_balance")
                .delete()
                .eq("shop_id", shopId)
              
              if (deleteResult.error) {
                console.warn(`[SHOP-ORDERS-UPDATE] Warning deleting old balance:`, deleteResult.error)
              }

              const { data, error: insertError } = await supabase
                .from("shop_available_balance")
                .insert([
                  {
                    shop_id: shopId,
                    available_balance: availableBalance,
                    total_profit: breakdown.totalProfit,
                    withdrawn_amount: breakdown.withdrawnProfit,
                    credited_profit: breakdown.creditedProfit,
                    withdrawn_profit: breakdown.withdrawnProfit,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  }
                ])

              if (insertError) {
                console.error(`[SHOP-ORDERS-UPDATE] Error syncing balance for shop ${shopId}:`, insertError)
                throw new Error(`Failed to sync balance: ${insertError.message}`)
              }

              console.log(`[SHOP-ORDERS-UPDATE] ✓ Synced available balance for shop: ${shopId} - Available: GHS ${availableBalance.toFixed(2)}`)
            }
          } catch (syncError) {
            console.warn(`[SHOP-ORDERS-UPDATE] Warning: Could not sync balance for shop ${shopId}:`, syncError)
            // Don't throw - profit was already credited, this is just a sync
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      count: orderIds.length,
      status,
      profitsUpdated: status === "completed"
    })
  } catch (error) {
    console.error("[SHOP-ORDERS-UPDATE] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
