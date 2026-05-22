import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { type NotificationType } from "@/lib/notification-service"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { sendEmail } from "@/lib/email-service"
import { sendPushToUser } from "@/lib/push-service"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

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

    // Also update MTN fulfillment tracking records if they exist
    try {
      const { error: mtnUpdateError } = await supabase
        .from("mtn_fulfillment_tracking")
        .update({ 
          status: status, 
          updated_at: new Date().toISOString() 
        })
        .in("shop_order_id", orderIds)

      if (mtnUpdateError) {
        console.warn("[SHOP-ORDERS-UPDATE] Error updating MTN tracking:", mtnUpdateError)
      } else {
        console.log(`[SHOP-ORDERS-UPDATE] ✓ Updated MTN tracking records for ${orderIds.length} orders`)
      }
    } catch (mtnError) {
      console.warn("[SHOP-ORDERS-UPDATE] Error updating MTN tracking:", mtnError)
    }

    // Send in-app, push, and email notifications
    try {
      const { data: shopOrders, error: ordersError } = await supabase
        .from("shop_orders")
        .select("id, user_id, network, volume_gb, phone_number, customer_email, customer_name, reference_code, total_price")
        .in("id", orderIds)

      if (!ordersError && shopOrders && shopOrders.length > 0) {
        // ── Title / message helpers ───────────────────────────────────────────
        function buildTitle(s: string) {
          if (s === "completed")  return "Order Completed"
          if (s === "processing") return "Order Processing"
          if (s === "failed")     return "Order Failed"
          return "Order Status Updated"
        }
        function buildMessage(order: NonNullable<typeof shopOrders>[0], s: string) {
          const desc = `${order.network} ${order.volume_gb}GB`
          if (s === "completed")  return `Your ${desc} data order has been delivered to ${order.phone_number}.`
          if (s === "processing") return `Your ${desc} data order is now being processed for ${order.phone_number}.`
          if (s === "failed")     return `Your ${desc} data order for ${order.phone_number} could not be delivered. Please contact support.`
          return `Your ${desc} data order status has been updated to: ${s}.`
        }

        // 1. In-app notifications (batch insert — only for logged-in users)
        const notifications = shopOrders
          .filter(o => o.user_id)
          .map(order => ({
            user_id: order.user_id,
            title: buildTitle(status),
            message: buildMessage(order, status),
            type: "order_update" as NotificationType,
            reference_id: order.id,
            action_url: `/dashboard/my-orders`,
            read: false,
          }))

        if (notifications.length > 0) {
          const { error: notifError } = await supabase.from("notifications").insert(notifications)
          if (notifError) {
            console.warn(`[SHOP-ORDERS-UPDATE] In-app notifications failed:`, notifError)
          } else {
            console.log(`[SHOP-ORDERS-UPDATE] ✓ ${notifications.length} in-app notifications sent`)
          }
        }

        // 2. Push notifications — one per unique user_id, fire-and-forget
        const uniqueUserIds = [...new Set(shopOrders.map(o => o.user_id).filter(Boolean))]
        if (uniqueUserIds.length > 0) {
          Promise.allSettled(
            uniqueUserIds.map(userId => {
              const userOrders = shopOrders.filter(o => o.user_id === userId)
              const title = buildTitle(status)
              const body = userOrders.length === 1
                ? buildMessage(userOrders[0], status)
                : `${userOrders.length} of your data orders have been ${status}.`
              return sendPushToUser(userId, { title, body, data: { url: "/dashboard/my-orders" } })
            })
          ).then(results => {
            const failed = results.filter(r => r.status === "rejected").length
            console.log(`[SHOP-ORDERS-UPDATE] ✓ Push: ${uniqueUserIds.length - failed}/${uniqueUserIds.length} users notified`)
          }).catch(() => {})
        }

        // 3. Email notifications — one per unique customer_email, fire-and-forget
        const emailMap = new Map<string, typeof shopOrders>()
        for (const order of shopOrders) {
          if (!order.customer_email) continue
          const key = order.customer_email.toLowerCase()
          if (!emailMap.has(key)) emailMap.set(key, [])
          emailMap.get(key)!.push(order)
        }

        if (emailMap.size > 0) {
          const statusLabel = status === "completed" ? "Delivered" : status === "processing" ? "Processing" : status === "failed" ? "Failed" : "Updated"
          const statusColor = status === "completed" ? "#16a34a" : status === "processing" ? "#d97706" : status === "failed" ? "#dc2626" : "#6366f1"

          Promise.allSettled(
            [...emailMap.entries()].map(([email, orders]) => {
              const firstName = orders[0].customer_name?.split(" ")[0] ?? "Customer"
              const orderRows = orders.map(o => `
                <tr>
                  <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;color:#374151;">${o.network} ${o.volume_gb}GB</td>
                  <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;color:#374151;">${o.phone_number}</td>
                  <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;">
                    <span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${statusColor}20;color:${statusColor};font-weight:600;font-size:12px;">${statusLabel}</span>
                  </td>
                </tr>`).join("")

              const htmlContent = `
                <div style="font-family:Inter,-apple-system,BlinkMacSystemFont,Arial,sans-serif;background:#f3f4f6;padding:20px 0;">
                  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
                    <div style="background:#0f172a;padding:28px 24px;text-align:center;background-image:radial-gradient(#1e293b 1px,#0f172a 1px);background-size:20px 20px;">
                      <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#fbbf24;">DATAGOD</p>
                      <h1 style="margin:8px 0 0;font-size:22px;font-weight:700;color:#fff;">Order Status Update</h1>
                    </div>
                    <div style="padding:28px 24px;">
                      <p style="margin:0 0 16px;font-size:15px;color:#374151;">Hi ${firstName},</p>
                      <p style="margin:0 0 20px;font-size:14px;color:#6b7280;">
                        ${orders.length === 1
                          ? `Your data order has been marked as <strong style="color:${statusColor};">${statusLabel}</strong>.`
                          : `${orders.length} of your data orders have been marked as <strong style="color:${statusColor};">${statusLabel}</strong>.`}
                      </p>
                      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
                        <thead>
                          <tr style="background:#f9fafb;">
                            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb;">Package</th>
                            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb;">Phone</th>
                            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb;">Status</th>
                          </tr>
                        </thead>
                        <tbody>${orderRows}</tbody>
                      </table>
                      ${status === "failed" ? `<p style="margin:0 0 16px;font-size:13px;color:#dc2626;background:#fef2f2;padding:12px;border-radius:8px;border-left:3px solid #dc2626;">If you were charged, a refund will be processed within 3–5 business days. Contact support if you have questions.</p>` : ""}
                      <p style="margin:16px 0 0;font-size:13px;color:#9ca3af;text-align:center;">DataGod · Accra, Ghana</p>
                    </div>
                  </div>
                </div>`

              return sendEmail({
                to: [{ email, name: orders[0].customer_name ?? undefined }],
                subject: `Your DataGod order is ${statusLabel}`,
                htmlContent,
                type: "order_status_update",
                referenceId: orders[0].id,
              })
            })
          ).then(results => {
            const failed = results.filter(r => r.status === "rejected").length
            console.log(`[SHOP-ORDERS-UPDATE] ✓ Email: ${emailMap.size - failed}/${emailMap.size} customers notified`)
          }).catch(() => {})
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
