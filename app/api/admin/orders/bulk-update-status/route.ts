import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { notificationTemplates, type NotificationType } from "@/lib/notification-service"

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

      // Also update MTN fulfillment tracking records if they exist (by order_id for bulk)
      try {
        const { error: mtnUpdateError } = await supabase
          .from("mtn_fulfillment_tracking")
          .update({ 
            status: status, 
            updated_at: new Date().toISOString() 
          })
          .in("order_id", bulkOrderIds)

        if (mtnUpdateError) {
          console.warn("[BULK-UPDATE] Error updating MTN tracking for bulk orders:", mtnUpdateError)
        } else {
          console.log(`[BULK-UPDATE] ✓ Updated MTN tracking records for bulk orders`)
        }
      } catch (mtnError) {
        console.warn("[BULK-UPDATE] Error updating MTN tracking for bulk orders:", mtnError)
      }

      // Send notifications for completed or failed bulk orders
      if (status === "completed" || status === "failed") {
        try {
          // Get order details to send notifications
          const { data: orders, error: ordersError } = await supabase
            .from("orders")
            .select("id, user_id, network, size, phone_number")
            .in("id", bulkOrderIds)

          if (!ordersError && orders && orders.length > 0) {
            // Batch insert all notifications at once
            const notifications = orders.map((order) => {
              if (status === "completed") {
                const notificationData = notificationTemplates.orderCompleted(order.id, "")
                return {
                  user_id: order.user_id,
                  title: notificationData.title,
                  message: `Your ${order.network} ${order.size} data order has been completed. Phone: ${order.phone_number}`,
                  type: notificationData.type,
                  reference_id: order.id,
                  action_url: `/dashboard/my-orders`,
                  read: false,
                }
              } else {
                return {
                  user_id: order.user_id,
                  title: "Order Failed",
                  message: `Your ${order.network} ${order.size} data order has failed. Please contact support. Phone: ${order.phone_number}`,
                  type: "order_update" as NotificationType,
                  reference_id: order.id,
                  action_url: `/dashboard/my-orders`,
                  read: false,
                }
              }
            })

            const { error: notifError } = await supabase
              .from("notifications")
              .insert(notifications)

            if (notifError) {
              console.warn(`[NOTIFICATION] Failed to send ${notifications.length} bulk notifications:`, notifError)
            } else {
              console.log(`[NOTIFICATION] Sent ${notifications.length} bulk order status notifications`)
            }
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
      
      // Before update - verify orders exist
      const { data: beforeUpdate, error: beforeError } = await supabase
        .from("shop_orders")
        .select("id, order_status")
        .in("id", shopOrderIds.slice(0, 3))

      if (!beforeError && beforeUpdate) {
        console.log(`[BULK-UPDATE] Before update - First 3 orders:`, beforeUpdate)
      }

      const { data: updateData, error: updateError } = await supabase
        .from("shop_orders")
        .update({ order_status: status, updated_at: new Date().toISOString() })
        .in("id", shopOrderIds)
        .select("id, order_status, updated_at")

      if (updateError) {
        console.error("[BULK-UPDATE] Error updating shop orders:", JSON.stringify(updateError))
        throw new Error(`Failed to update shop order status: ${updateError.message}`)
      }

      if (!updateData) {
        console.error("[BULK-UPDATE] Update returned no data!")
        throw new Error("Shop order update failed: no data returned from database")
      }

      console.log(`[BULK-UPDATE] ✓ Update query completed`)
      console.log(`[BULK-UPDATE] Updated rows returned:`, updateData?.length || 0)
      if (updateData && updateData.length > 0) {
        console.log(`[BULK-UPDATE] Sample updated records:`, updateData.slice(0, 3))
      }

      // Verify the update actually worked by fetching back
      const { data: verifyData, error: verifyError } = await supabase
        .from("shop_orders")
        .select("id, order_status")
        .in("id", shopOrderIds.slice(0, 3))

      if (verifyError) {
        console.error("[BULK-UPDATE] Error during verification fetch:", verifyError)
      } else if (verifyData) {
        console.log(`[BULK-UPDATE] Verification - After update, first 3 orders:`, verifyData)
        // Check if status actually changed
        const statusChanged = verifyData.every(o => o.order_status === status)
        if (!statusChanged) {
          console.warn("[BULK-UPDATE] WARNING: Status update did not persist!")
          verifyData.forEach(o => {
            console.warn(`  Order ${o.id}: expected "${status}" but got "${o.order_status}"`)
          })
        }
      }

      // Also update MTN fulfillment tracking records for shop orders
      try {
        const { error: mtnUpdateError } = await supabase
          .from("mtn_fulfillment_tracking")
          .update({ 
            status: status, 
            updated_at: new Date().toISOString() 
          })
          .in("shop_order_id", shopOrderIds)

        if (mtnUpdateError) {
          console.warn("[BULK-UPDATE] Error updating MTN tracking for shop orders:", mtnUpdateError)
        } else {
          console.log(`[BULK-UPDATE] ✓ Updated MTN tracking records for shop orders`)
        }
      } catch (mtnError) {
        console.warn("[BULK-UPDATE] Error updating MTN tracking for shop orders:", mtnError)
      }

      // Send notifications for completed or failed shop orders
      if (status === "completed" || status === "failed") {
        try {
          // Get shop order details to send notifications
          const { data: shopOrderDetails, error: ordersError } = await supabase
            .from("shop_orders")
            .select("id, user_id, network, volume_gb, phone_number")
            .in("id", shopOrderIds)

          if (!ordersError && shopOrderDetails && shopOrderDetails.length > 0) {
            // Batch insert all notifications at once
            const notifications = shopOrderDetails.map((order) => {
              if (status === "completed") {
                const notificationData = notificationTemplates.orderCompleted(order.id, "")
                return {
                  user_id: order.user_id,
                  title: notificationData.title,
                  message: `Your ${order.network} ${order.volume_gb}GB data order has been completed. Phone: ${order.phone_number}`,
                  type: notificationData.type,
                  reference_id: order.id,
                  action_url: `/dashboard/my-orders`,
                  read: false,
                }
              } else {
                return {
                  user_id: order.user_id,
                  title: "Order Failed",
                  message: `Your ${order.network} ${order.volume_gb}GB data order has failed. Please contact support. Phone: ${order.phone_number}`,
                  type: "order_update" as NotificationType,
                  reference_id: order.id,
                  action_url: `/dashboard/my-orders`,
                  read: false,
                }
              }
            })

            const { error: notifError } = await supabase
              .from("notifications")
              .insert(notifications)

            if (notifError) {
              console.warn(`[NOTIFICATION] Failed to send ${notifications.length} shop notifications:`, notifError)
            } else {
              console.log(`[NOTIFICATION] Sent ${notifications.length} shop order status notifications`)
            }
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
