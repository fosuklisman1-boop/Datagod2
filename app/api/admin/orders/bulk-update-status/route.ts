import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { notificationService, notificationTemplates } from "@/lib/notification-service"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { orderIds, status, orderType } = await request.json()

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

    console.log(`[BULK-UPDATE] Updating ${orderIds.length} ${orderType || 'bulk'} orders to status: ${status}`)

    // Determine if these are bulk orders or shop orders
    const isBulkOrder = orderType !== 'shop'

    if (isBulkOrder) {
      // Update regular bulk orders
      const { error: updateError } = await supabase
        .from("orders")
        .update({ status })
        .in("id", orderIds)

      if (updateError) {
        throw new Error(`Failed to update order status: ${updateError.message}`)
      }

      console.log(`[BULK-UPDATE] ✓ Updated ${orderIds.length} bulk orders to status: ${status}`)

      // Send notifications for completed or failed orders
      if (status === "completed" || status === "failed") {
        try {
          // Get order details to send notifications
          const { data: orders, error: ordersError } = await supabase
            .from("orders")
            .select("id, user_id, network, size")
            .in("id", orderIds)

          if (!ordersError && orders) {
            for (const order of orders) {
              try {
                if (status === "completed") {
                  const notificationData = notificationTemplates.orderCompleted(order.id, "")
                  await notificationService.createNotification(
                    order.user_id,
                    notificationData.title,
                    `Your ${order.network} ${order.size} data order has been completed.`,
                    notificationData.type,
                    {
                      reference_id: order.id,
                      action_url: `/dashboard/my-orders`,
                    }
                  )
                } else if (status === "failed") {
                  await notificationService.createNotification(
                    order.user_id,
                    "Order Failed",
                    `Your ${order.network} ${order.size} data order has failed. Please contact support.`,
                    "order_update",
                    {
                      reference_id: order.id,
                      action_url: `/dashboard/my-orders`,
                    }
                  )
                }
              } catch (notifError) {
                console.warn(`[NOTIFICATION] Failed to send notification for order ${order.id}:`, notifError)
              }
            }
            console.log(`[NOTIFICATION] Sent ${orders.length} order status notifications`)
          }
        } catch (error) {
          console.warn("[NOTIFICATION] Error sending bulk notifications:", error)
        }
      }
    } else {
      // Update shop orders and credit profits if completing
      const { error: updateError } = await supabase
        .from("shop_orders")
        .update({ order_status: status, updated_at: new Date().toISOString() })
        .in("id", orderIds)

      if (updateError) {
        console.error("[BULK-UPDATE] Error updating shop orders:", updateError)
        throw new Error(`Failed to update shop order status: ${updateError.message}`)
      }

      console.log(`[BULK-UPDATE] ✓ Updated ${orderIds.length} shop orders to status: ${status}`)

      // Send notifications for completed or failed shop orders
      if (status === "completed" || status === "failed") {
        try {
          // Get shop order details to send notifications
          const { data: shopOrders, error: ordersError } = await supabase
            .from("shop_orders")
            .select("id, user_id, network_name, package_name")
            .in("id", orderIds)

          if (!ordersError && shopOrders) {
            for (const order of shopOrders) {
              try {
                if (status === "completed") {
                  const notificationData = notificationTemplates.orderCompleted(order.id, "")
                  await notificationService.createNotification(
                    order.user_id,
                    notificationData.title,
                    `Your ${order.network_name} ${order.package_name} order has been completed.`,
                    notificationData.type,
                    {
                      reference_id: order.id,
                      action_url: `/dashboard/my-orders`,
                    }
                  )
                } else if (status === "failed") {
                  await notificationService.createNotification(
                    order.user_id,
                    "Order Failed",
                    `Your ${order.network_name} ${order.package_name} order has failed. Please contact support.`,
                    "order_update",
                    {
                      reference_id: order.id,
                      action_url: `/dashboard/my-orders`,
                    }
                  )
                }
              } catch (notifError) {
                console.warn(`[NOTIFICATION] Failed to send notification for shop order ${order.id}:`, notifError)
              }
            }
            console.log(`[NOTIFICATION] Sent ${shopOrders.length} shop order status notifications`)
          }
        } catch (error) {
          console.warn("[NOTIFICATION] Error sending shop order notifications:", error)
        }
      }

      // If status is "completed", credit the associated profits
      if (status === "completed") {
        console.log(`[BULK-UPDATE] Crediting profits for ${orderIds.length} completed orders...`)

        // Get the profit records for these orders
        const { data: profitRecords, error: profitFetchError } = await supabase
          .from("shop_profits")
          .select("id, shop_id, profit_amount, status")
          .in("shop_order_id", orderIds)
          .eq("status", "pending")

        if (profitFetchError) {
          console.error("[BULK-UPDATE] Error fetching profit records:", profitFetchError)
          throw new Error(`Failed to fetch profit records: ${profitFetchError.message}`)
        }

        console.log(`[BULK-UPDATE] Found ${profitRecords?.length || 0} pending profit records`)

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
            const result = await supabase
              .from("shop_profits")
              .update(updatePayload)
              .in("id", profitIds)
            profitUpdateError = result.error
          }

          if (profitUpdateError) {
            console.error("[BULK-UPDATE] Error updating profit records:", profitUpdateError)
            throw new Error(`Failed to update profit records: ${profitUpdateError.message}`)
          }

          const totalProfit = profitRecords.reduce((sum, p) => sum + p.profit_amount, 0)
          console.log(`[BULK-UPDATE] ✓ Credited ${profitRecords.length} profit records (GHS ${totalProfit.toFixed(2)})`)

          // Sync available balance for each shop
          const shopIds = [...new Set(profitRecords.map(p => p.shop_id))]
          
          for (const shopId of shopIds) {
            try {
              // Get all profits for this shop to calculate available balance
              const { data: profits, error: profitFetchError } = await supabase
                .from("shop_profits")
                .select("profit_amount, status")
                .eq("shop_id", shopId)

              if (!profitFetchError && profits) {
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

                // Get approved withdrawals to subtract from available balance
                const { data: approvedWithdrawals, error: withdrawalError } = await supabase
                  .from("withdrawal_requests")
                  .select("amount")
                  .eq("shop_id", shopId)
                  .eq("status", "approved")

                let totalApprovedWithdrawals = 0
                if (!withdrawalError && approvedWithdrawals) {
                  totalApprovedWithdrawals = approvedWithdrawals.reduce((sum, w) => sum + (w.amount || 0), 0)
                }

                // Available balance = credited profit - approved withdrawals
                const availableBalance = Math.max(0, breakdown.creditedProfit - totalApprovedWithdrawals)

                // Delete existing record and insert fresh (more reliable than upsert)
                const deleteResult = await supabase
                  .from("shop_available_balance")
                  .delete()
                  .eq("shop_id", shopId)
                
                if (deleteResult.error) {
                  console.warn(`[BULK-UPDATE] Warning deleting old balance:`, deleteResult.error)
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
                  console.error(`[BULK-UPDATE] Error syncing balance for shop ${shopId}:`, insertError)
                  throw new Error(`Failed to sync balance: ${insertError.message}`)
                }

                console.log(`[BULK-UPDATE] ✓ Synced available balance for shop: ${shopId} - Available: GHS ${availableBalance.toFixed(2)}`)
              }
            } catch (syncError) {
              console.warn(`[BULK-UPDATE] Warning: Could not sync balance for shop ${shopId}:`, syncError)
              // Don't throw - profit was already credited, this is just a sync
            }
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      count: orderIds.length,
      status,
      orderType: isBulkOrder ? 'bulk' : 'shop'
    })
  } catch (error) {
    console.error("[BULK-UPDATE] Error in bulk update status:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
