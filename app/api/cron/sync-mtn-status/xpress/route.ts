import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"
import { verifyCronAuth } from "@/lib/cron-auth"
import { sendPushToUser } from "@/lib/push-service"
import { fetchReversalCandidates, isReversal, flagReversal } from "@/lib/mtn-reversal"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// Xpress allows 60 req/min (~1 req/sec). At 1000ms delay we can safely do 50 per cron tick.
const BATCH_SIZE = 50
const DELAY_BETWEEN_REQUESTS_MS = 1000
const DELAY_ON_429_MS = 10000

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * GET /api/cron/sync-mtn-status/xpress
 *
 * Polls Xpress GET /orders/:id for each pending/processing order
 * and updates mtn_fulfillment_tracking + the originating order table.
 * Sends in-app notifications on completed/failed.
 */
export async function GET(request: NextRequest) {
    const { authorized, errorResponse } = verifyCronAuth(request)
    if (!authorized && errorResponse) return errorResponse

    try {
        console.log("[CRON-XPRESS] Starting status sync...")

        const { data: pendingOrders, error: fetchError } = await supabase
            .from("mtn_fulfillment_tracking")
            .select("id, mtn_order_id, status, shop_order_id, order_id, api_order_id, order_type")
            .eq("provider", "xpress")
            .in("status", ["pending", "processing"])
            .order("created_at", { ascending: true })
            .limit(BATCH_SIZE)

        if (fetchError) {
            console.error("[CRON-XPRESS] Error fetching orders:", fetchError)
            return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
        }

        if (!pendingOrders || pendingOrders.length === 0) {
            return NextResponse.json({ success: true, message: "No Xpress orders to sync" })
        }

        console.log(`[CRON-XPRESS] Found ${pendingOrders.length} orders to sync`)

        let synced = 0
        let failed = 0
        let rateLimited = 0
        const results = []

        for (let i = 0; i < pendingOrders.length; i++) {
            const order = pendingOrders[i]

            try {
                console.log(`[CRON-XPRESS] Syncing ${i + 1}/${pendingOrders.length}: ${order.mtn_order_id}`)

                const result = await checkMTNOrderStatus(order.mtn_order_id, "xpress")

                if (!result.success && result.message?.includes("429")) {
                    console.warn(`[CRON-XPRESS] Rate limited on ${order.mtn_order_id}, waiting ${DELAY_ON_429_MS}ms...`)
                    rateLimited++
                    failed++
                    results.push({ id: order.id, mtn_order_id: order.mtn_order_id, success: false, status: order.status, message: "Rate limited" })
                    await sleep(DELAY_ON_429_MS)
                    continue
                }

                if (result.success && result.status) {
                    const oldStatus = order.status
                    const newStatus = result.status

                    // Prevent status regression
                    const statusPriority: Record<string, number> = { pending: 1, processing: 2, completed: 3, failed: 3 }
                    const currentPriority = statusPriority[oldStatus] ?? 0
                    const newPriority = statusPriority[newStatus] ?? 0

                    if (newPriority < currentPriority) {
                        console.log(`[CRON-XPRESS] ⛔ Skipping regression ${oldStatus} -> ${newStatus} for order ${order.mtn_order_id}`)
                    } else if (newStatus !== oldStatus) {
                        await supabase
                            .from("mtn_fulfillment_tracking")
                            .update({
                                status: newStatus,
                                external_status: result.order?.status || newStatus,
                                external_message: result.message,
                                updated_at: new Date().toISOString(),
                            })
                            .eq("id", order.id)

                        // Mirror status to the originating order table and collect user/order details
                        const orderTableStatus = newStatus === "failed" ? "pending" : newStatus
                        let userId: string | null = null
                        let orderDetails: { network?: string; size?: string; phone?: string } = {}

                        if (order.order_type === "bulk" && order.order_id) {
                            const { data: orderData, error: orderError } = await supabase
                                .from("orders")
                                .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
                                .eq("id", order.order_id)
                                .select("user_id, network, size, phone_number")
                                .single()
                            if (orderError) {
                                console.error(`[CRON-XPRESS] ⚠️ Failed to update bulk order ${order.order_id}:`, orderError)
                            } else if (orderData) {
                                userId = orderData.user_id
                                orderDetails = { network: orderData.network, size: orderData.size, phone: orderData.phone_number }
                            }
                        } else if (order.order_type === "api" && (order.api_order_id || order.order_id)) {
                            const apiId = order.api_order_id || order.order_id
                            const { data: apiData, error: apiError } = await supabase
                                .from("api_orders")
                                .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
                                .eq("id", apiId)
                                .select("user_id, network, volume_gb, recipient_phone")
                                .single()
                            if (apiError) {
                                console.error(`[CRON-XPRESS] ⚠️ Failed to update API order ${apiId}:`, apiError)
                            } else if (apiData) {
                                userId = apiData.user_id
                                orderDetails = { network: apiData.network, size: `${apiData.volume_gb}GB`, phone: apiData.recipient_phone }
                            }
                        } else if (order.order_type === "ussd" && order.order_id) {
                            const { data: ussdData, error: ussdError } = await supabase
                                .from("ussd_orders")
                                .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
                                .eq("id", order.order_id)
                                .select("network, package_size, recipient_phone")
                                .single()
                            if (ussdError) {
                                console.error(`[CRON-XPRESS] ⚠️ Failed to update USSD order ${order.order_id}:`, ussdError)
                            } else if (ussdData) {
                                orderDetails = { network: ussdData.network, size: ussdData.package_size, phone: ussdData.recipient_phone }
                            }
                        } else if (order.order_type === "ussd_shop" && order.order_id) {
                            const { data: ussdShopData, error: ussdShopError } = await supabase
                                .from("ussd_shop_orders")
                                .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
                                .eq("id", order.order_id)
                                .select("network, package_size, recipient_phone")
                                .single()
                            if (ussdShopError) {
                                console.error(`[CRON-XPRESS] ⚠️ Failed to update USSD shop order ${order.order_id}:`, ussdShopError)
                            } else if (ussdShopData) {
                                orderDetails = { network: ussdShopData.network, size: ussdShopData.package_size, phone: ussdShopData.recipient_phone }
                            }
                        } else if (order.shop_order_id) {
                            const { data: shopData, error: shopError } = await supabase
                                .from("shop_orders")
                                .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
                                .eq("id", order.shop_order_id)
                                .select("shop_id, network, volume_gb, customer_phone")
                                .single()
                            if (shopError) {
                                console.error(`[CRON-XPRESS] ⚠️ Failed to update shop order ${order.shop_order_id}:`, shopError)
                            } else if (shopData) {
                                const { data: shopOwner } = await supabase
                                    .from("user_shops")
                                    .select("user_id")
                                    .eq("id", shopData.shop_id)
                                    .single()
                                userId = shopOwner?.user_id || null
                                orderDetails = { network: shopData.network, size: `${shopData.volume_gb}GB`, phone: shopData.customer_phone }
                            }
                        }

                        // Send in-app notification on terminal status
                        if (userId && (newStatus === "completed" || newStatus === "failed")) {
                            const notifTitle = newStatus === "completed"
                                ? "Order Delivered Successfully"
                                : "Order Delivery Failed"
                            const notifMessage = newStatus === "completed"
                                ? `Your MTN ${orderDetails.size || ""} data order to ${orderDetails.phone || "recipient"} has been delivered successfully.`
                                : `Your MTN ${orderDetails.size || ""} data order to ${orderDetails.phone || "recipient"} failed. Please contact support.`

                            const { error: notifError } = await supabase
                                .from("notifications")
                                .insert({
                                    user_id: userId,
                                    title: notifTitle,
                                    message: notifMessage,
                                    type: newStatus === "completed" ? "order_completed" : "order_failed",
                                    reference_id: order.api_order_id || order.order_id || order.shop_order_id,
                                    action_url: order.order_type === "bulk"
                                        ? `/dashboard/my-orders?orderId=${order.order_id}`
                                        : order.order_type === "api"
                                            ? `/dashboard/profile`
                                            : `/dashboard/shop/orders`,
                                    read: false,
                                })

                            if (notifError) {
                                console.error(`[CRON-XPRESS] ⚠️ Failed to send notification for order ${order.mtn_order_id}:`, notifError)
                            } else {
                                console.log(`[CRON-XPRESS] 🔔 Notification sent to user ${userId} for order ${order.mtn_order_id} (${newStatus})`)
                            }

                            sendPushToUser(userId, {
                                title: notifTitle,
                                body: notifMessage,
                                data: {
                                    url: order.order_type === "bulk"
                                        ? `/dashboard/my-orders?orderId=${order.order_id}`
                                        : order.order_type === "api"
                                            ? `/dashboard/profile`
                                            : `/dashboard/shop/orders`,
                                },
                            }).catch(() => {})
                        }

                        console.log(`[CRON-XPRESS] ✅ ${order.mtn_order_id}: ${oldStatus} -> ${newStatus}`)
                        synced++
                    } else {
                        console.log(`[CRON-XPRESS] ${order.mtn_order_id}: unchanged (${newStatus})`)
                    }
                } else {
                    console.warn(`[CRON-XPRESS] Failed to get status for ${order.mtn_order_id}:`, result.message)
                    failed++
                }

                results.push({
                    id: order.id,
                    mtn_order_id: order.mtn_order_id,
                    success: result.success,
                    status: result.status || order.status,
                    message: result.message,
                })

                if (i < pendingOrders.length - 1) {
                    await sleep(DELAY_BETWEEN_REQUESTS_MS)
                }
            } catch (err) {
                console.error(`[CRON-XPRESS] Error processing ${order.mtn_order_id}:`, err)
                failed++
            }
        }

        // ── Reversal safeguard (bounded to the existing rate budget) ──
        let reversed = 0
        const reversalCandidates = await fetchReversalCandidates(supabase, "xpress", BATCH_SIZE)
        for (const cand of reversalCandidates) {
            const chk = await checkMTNOrderStatus((cand as any).mtn_order_id, "xpress")
            if (!chk.success || !chk.status) { await sleep(DELAY_BETWEEN_REQUESTS_MS); continue }
            if (isReversal({ trackingStatus: "completed", completedAt: (cand as any).updated_at, providerStatus: chk.status })) {
                await flagReversal(supabase, cand, { status: chk.order?.status ?? "failed", message: chk.message })
                reversed++
            }
            await sleep(DELAY_BETWEEN_REQUESTS_MS)
        }

        return NextResponse.json({
            success: true,
            synced,
            failed,
            rateLimited,
            total: pendingOrders.length,
            results,
            reversed,
            config: { batchSize: BATCH_SIZE, delayBetweenRequests: DELAY_BETWEEN_REQUESTS_MS },
        })
    } catch (error) {
        console.error("[CRON-XPRESS] Critical error:", error)
        return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
}
