import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"
import { verifyCronAuth } from "@/lib/cron-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// Allow the function up to 60s so a full batch can complete within one run
export const maxDuration = 60

// Xpress allows 60 req/min; we stay well below that.
// 35 orders x 1.5s delay (+ request latency) fits inside the 60s budget.
const BATCH_SIZE = 35
const DELAY_BETWEEN_REQUESTS_MS = 1500
const DELAY_ON_429_MS = 10000

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * GET /api/cron/sync-mtn-status/xpress
 *
 * Polls Xpress GET /orders/:id for each pending/processing order
 * and updates mtn_fulfillment_tracking + the originating order table.
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

                    // Prevent status regression: Xpress may report "pending" while the order
                    // is queued on their side — never move an order backwards.
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

                        // Mirror status to the originating order table
                        const orderTableStatus = newStatus === "failed" ? "pending" : newStatus
                        if (order.order_type === "bulk" && order.order_id) {
                            await supabase.from("orders").update({ status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", order.order_id)
                        } else if (order.order_type === "api" && (order.api_order_id || order.order_id)) {
                            const apiId = order.api_order_id || order.order_id
                            await supabase.from("api_orders").update({ status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", apiId)
                        } else if (order.order_type === "ussd" && order.order_id) {
                            await supabase.from("ussd_orders").update({ order_status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", order.order_id)
                        } else if (order.order_type === "ussd_shop" && order.order_id) {
                            await supabase.from("ussd_shop_orders").update({ order_status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", order.order_id)
                        } else if (order.shop_order_id) {
                            await supabase.from("shop_orders").update({ order_status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", order.shop_order_id)
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

        return NextResponse.json({
            success: true,
            synced,
            failed,
            rateLimited,
            total: pendingOrders.length,
            results,
            config: { batchSize: BATCH_SIZE, delayBetweenRequests: DELAY_BETWEEN_REQUESTS_MS },
        })
    } catch (error) {
        console.error("[CRON-XPRESS] Critical error:", error)
        return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
}
