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

    console.log(`[BULK-UPDATE] Request received:`)
    console.log(`[BULK-UPDATE]   - Order IDs: ${orderIds.length} total`)
    console.log(`[BULK-UPDATE]   - First 5 IDs: ${orderIds.slice(0, 5).join(", ")}`)
    console.log(`[BULK-UPDATE]   - Status: ${status}`)
    console.log(`[BULK-UPDATE]   - Order type hint: ${orderType || 'not specified'}`)

    // Determine actual order types by checking both tables
    const { data: bulkOrders, error: bulkError } = await supabase
      .from("orders")
      .select("id")
      .in("id", orderIds)

    if (bulkError) {
      console.warn(`[BULK-UPDATE] Error checking bulk orders table:`, bulkError.message)
    }

    const { data: shopOrders, error: shopError } = await supabase
      .from("shop_orders")
      .select("id")
      .in("id", orderIds)

    if (shopError) {
      console.warn(`[BULK-UPDATE] Error checking shop_orders table:`, shopError.message)
    }

    const bulkOrderIds = bulkOrders?.map(o => o.id) || []
    const shopOrderIds = shopOrders?.map(o => o.id) || []

    console.log(`[BULK-UPDATE] Detected: ${bulkOrderIds.length} bulk orders, ${shopOrderIds.length} shop orders`)
    if (bulkOrderIds.length > 0) {
      console.log(`[BULK-UPDATE] Bulk order IDs:`, bulkOrderIds.slice(0, 5).join(", ") + (bulkOrderIds.length > 5 ? "..." : ""))
    }
    if (shopOrderIds.length > 0) {
      console.log(`[BULK-UPDATE] Shop order IDs:`, shopOrderIds.slice(0, 5).join(", ") + (shopOrderIds.length > 5 ? "..." : ""))
    }

    // Update bulk orders
    if (bulkOrderIds.length > 0) {
      const { error: updateError } = await supabase
        .from("orders")
        .update({ status })
        .in("id", bulkOrderIds)

      if (updateError) {
        throw new Error(`Failed to update bulk order status: ${updateError.message}`)
      }

      console.log(`[BULK-UPDATE] ✓ Updated ${bulkOrderIds.length} bulk orders to status: ${status}`)

      // Send notifications for completed or failed bulk orders
      if (status === "completed" || status === "failed") {
        try {
          // Get order details to send notifications
          const { data: orders, error: ordersError } = await supabase
            .from("orders")
            .select("id, user_id, network, size")
            .in("id", bulkOrderIds)

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
            console.log(`[NOTIFICATION] Sent ${orders.length} bulk order status notifications`)
          }
        } catch (error) {
          console.warn("[NOTIFICATION] Error sending bulk notifications:", error)
        }
      }
    }

    // Update shop orders
    if (shopOrderIds.length > 0) {
      console.log(`[BULK-UPDATE] Updating ${shopOrderIds.length} shop orders in shop_orders table...`)
      console.log(`[BULK-UPDATE] Setting order_status = "${status}" for IDs:`, shopOrderIds.slice(0, 3).join(", "))
      
      const { data: updateData, error: updateError } = await supabase
        .from("shop_orders")
        .update({ order_status: status, updated_at: new Date().toISOString() })
        .in("id", shopOrderIds)
        .select("id, order_status, updated_at")

      if (updateError) {
        console.error("[BULK-UPDATE] Error updating shop orders:", updateError)
        throw new Error(`Failed to update shop order status: ${updateError.message}`)
      }

      console.log(`[BULK-UPDATE] ✓ Update query completed`)
      console.log(`[BULK-UPDATE] Updated rows returned:`, updateData?.length || 0)
      if (updateData && updateData.length > 0) {
        console.log(`[BULK-UPDATE] Sample updated record:`, {
          id: updateData[0].id,
          order_status: updateData[0].order_status,
          updated_at: updateData[0].updated_at
        })
      }

      // Verify the update actually worked by fetching back
      const { data: verifyData, error: verifyError } = await supabase
        .from("shop_orders")
        .select("id, order_status")
        .in("id", shopOrderIds.slice(0, 3))

      if (!verifyError && verifyData) {
        console.log(`[BULK-UPDATE] Verification fetch - First 3 orders:`, verifyData)
      }

      // Send notifications for completed or failed shop orders
      if (status === "completed" || status === "failed") {
        try {
          // Get shop order details to send notifications
          const { data: shopOrderDetails, error: ordersError } = await supabase
            .from("shop_orders")
            .select("id, user_id, network, volume_gb")
            .in("id", shopOrderIds)

          if (!ordersError && shopOrderDetails) {
            for (const order of shopOrderDetails) {
              try {
                if (status === "completed") {
                  const notificationData = notificationTemplates.orderCompleted(order.id, "")
                  await notificationService.createNotification(
                    order.user_id,
                    notificationData.title,
                    `Your ${order.network} ${order.volume_gb}GB data order has been completed.`,
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
                    `Your ${order.network} ${order.volume_gb}GB data order has failed. Please contact support.`,
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
            console.log(`[NOTIFICATION] Sent ${shopOrderDetails.length} shop order status notifications`)
          }
        } catch (error) {
          console.warn("[NOTIFICATION] Error sending shop order notifications:", error)
        }
      }

      // If status is "completed", credit the associated profits
      if (status === "completed") {
        console.log(`[BULK-UPDATE] Crediting profits for ${shopOrderIds.length} completed orders...`)

        // Get the profit records for these orders
        const { data: profitRecords, error: profitFetchError } = await supabase
          .from("shop_profits")
          .select("id, shop_id, profit_amount, status")
          .in("shop_order_id", shopOrderIds)
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
      bulkCount: bulkOrderIds.length,
      shopCount: shopOrderIds.length
    })
  } catch (error) {
    console.error("[BULK-UPDATE] Error in bulk update status:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
