import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"
import { verifyCronAuth } from "@/lib/cron-auth"
import { sendPushToUser } from "@/lib/push-service"
import { fetchReversalCandidates, isReversal, flagReversal } from "@/lib/mtn-reversal"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

const BATCH_SIZE = 50
const DELAY_BETWEEN_REQUESTS_MS = 1000

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * GET /api/cron/sync-mtn-status/apexprime
 *
 * Polling fallback for Apex Prime orders whose webhook was missed. Mirrors
 * the Xpress cron's structure (sequential polling, no batch/retry
 * disambiguation needed — Apex Prime gives a stable id per order via the
 * bundle:/store: prefix, with no documented retry-splits-into-new-order
 * behavior like AgentPortalGH's).
 */
export async function GET(request: NextRequest) {
    const { authorized, errorResponse } = verifyCronAuth(request)
    if (!authorized && errorResponse) return errorResponse

    try {
        console.log("[CRON-APEXPRIME] Starting status sync...")

        const { data: pendingOrders, error: fetchError } = await supabase
            .from("mtn_fulfillment_tracking")
            .select("id, mtn_order_id, status, shop_order_id, order_id, api_order_id, order_type, recipient_phone, size_gb")
            .eq("provider", "apexprime")
            .in("status", ["pending", "processing"])
            .order("created_at", { ascending: true })
            .limit(BATCH_SIZE)

        if (fetchError) {
            console.error("[CRON-APEXPRIME] Error fetching orders:", fetchError)
            return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
        }

        if (!pendingOrders || pendingOrders.length === 0) {
            return NextResponse.json({ success: true, message: "No Apex Prime orders to sync" })
        }

        console.log(`[CRON-APEXPRIME] Found ${pendingOrders.length} orders to sync`)

        let synced = 0
        let failed = 0
        const results = []

        for (let i = 0; i < pendingOrders.length; i++) {
            const order = pendingOrders[i]

            try {
                const result = await checkMTNOrderStatus(order.mtn_order_id, "apexprime")

                if (result.success && result.status) {
                    const oldStatus = order.status
                    const newStatus = result.status
                    const statusPriority: Record<string, number> = { pending: 1, processing: 2, completed: 3, failed: 3, reversed: 4, abandoned: 4 }

                    if ((statusPriority[newStatus] ?? 0) < (statusPriority[oldStatus] ?? 0)) {
                        console.log(`[CRON-APEXPRIME] ⛔ Skipping regression ${oldStatus} -> ${newStatus} for ${order.mtn_order_id}`)
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

                        const orderTableStatus = newStatus === "failed" ? "pending" : newStatus
                        let userId: string | null = null

                        if (order.order_type === "bulk" && order.order_id) {
                            const { data } = await supabase
                                .from("orders")
                                .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
                                .eq("id", order.order_id)
                                .select("user_id")
                                .single()
                            userId = data?.user_id ?? null
                        } else if (order.order_type === "api" && (order.api_order_id || order.order_id)) {
                            const { data } = await supabase
                                .from("api_orders")
                                .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
                                .eq("id", order.api_order_id || order.order_id)
                                .select("user_id")
                                .single()
                            userId = data?.user_id ?? null
                        } else if (order.order_type === "ussd" && order.order_id) {
                            await supabase
                                .from("ussd_orders")
                                .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
                                .eq("id", order.order_id)
                        } else if (order.order_type === "ussd_shop" && order.order_id) {
                            await supabase
                                .from("ussd_shop_orders")
                                .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
                                .eq("id", order.order_id)
                        } else if (order.shop_order_id) {
                            const { data: shopData } = await supabase
                                .from("shop_orders")
                                .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
                                .eq("id", order.shop_order_id)
                                .select("shop_id")
                                .single()
                            if (shopData?.shop_id) {
                                const { data: owner } = await supabase.from("user_shops").select("user_id").eq("id", shopData.shop_id).single()
                                userId = owner?.user_id ?? null
                            }
                        }

                        if (userId && (newStatus === "completed" || newStatus === "failed")) {
                            const title = newStatus === "completed" ? "Order Delivered Successfully" : "Order Delivery Failed"
                            const body = newStatus === "completed"
                                ? `Your ${order.size_gb ?? ""}GB data order to ${order.recipient_phone ?? "recipient"} has been delivered successfully.`
                                : `Your ${order.size_gb ?? ""}GB data order to ${order.recipient_phone ?? "recipient"} failed. Please contact support.`
                            await supabase.from("notifications").insert({
                                user_id: userId,
                                title,
                                message: body,
                                type: newStatus === "completed" ? "order_completed" : "order_failed",
                                reference_id: order.api_order_id || order.order_id || order.shop_order_id,
                                read: false,
                            })
                            sendPushToUser(userId, { title, body }).catch(() => {})
                        }

                        console.log(`[CRON-APEXPRIME] ✅ ${order.mtn_order_id}: ${oldStatus} -> ${newStatus}`)
                        synced++
                    }
                } else {
                    console.warn(`[CRON-APEXPRIME] Failed to get status for ${order.mtn_order_id}:`, result.message)
                    failed++
                }

                results.push({ id: order.id, mtn_order_id: order.mtn_order_id, success: result.success, status: result.status || order.status, message: result.message })

                if (i < pendingOrders.length - 1) await sleep(DELAY_BETWEEN_REQUESTS_MS)
            } catch (err) {
                console.error(`[CRON-APEXPRIME] Error processing ${order.mtn_order_id}:`, err)
                failed++
            }
        }

        let reversed = 0
        const reversalCandidates = await fetchReversalCandidates(supabase, "apexprime", BATCH_SIZE)
        for (const cand of reversalCandidates) {
            const chk = await checkMTNOrderStatus((cand as any).mtn_order_id, "apexprime")
            if (!chk.success || !chk.status) { await sleep(DELAY_BETWEEN_REQUESTS_MS); continue }
            if (isReversal({ trackingStatus: "completed", completedAt: (cand as any).updated_at, providerStatus: chk.status })) {
                await flagReversal(supabase, cand, { status: chk.order?.status ?? "failed", message: chk.message })
                reversed++
            }
            await sleep(DELAY_BETWEEN_REQUESTS_MS)
        }

        return NextResponse.json({ success: true, synced, failed, total: pendingOrders.length, results, reversed })
    } catch (error) {
        console.error("[CRON-APEXPRIME] Critical error:", error)
        return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
}
