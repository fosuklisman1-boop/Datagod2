import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"
import { verifyCronAuth } from "@/lib/cron-auth"
import { syncWindowStartIso } from "@/lib/status-sync-window"
import { backgroundCron } from "@/lib/cron-background"
import { sendPushToUser } from "@/lib/push-service"
import { fetchReversalCandidates, isReversal, flagReversal } from "@/lib/mtn-reversal"
import { checkUnknownAttempts } from "@/lib/mtn-providers/kuntanii-unknown-attempts"
import { refreshStaleDisputes, sweepOrphanClaims } from "@/lib/mtn-providers/kuntanii-disputes"

// Answer the scheduler at once (cron-job.org times out at 30s); the sync runs after the response.
export const GET = backgroundCron("sync-kuntanii", (request) => runKuntaniiSync(request))

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

const BATCH_SIZE = 50
const DELAY_BETWEEN_REQUESTS_MS = 1000

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/** Runs one phase; a failure is reported in the result and never stops the next phase. */
async function phase<T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> {
    try {
        return await fn()
    } catch (err) {
        console.error(`[CRON-KUNTANII] ${name} phase failed:`, err instanceof Error ? err.message : err)
        return { error: "phase failed" }
    }
}

/**
 * GET /api/cron/sync-mtn-status/kuntanii
 *
 * Safety net for Kuntanii orders whose webhook was missed, then: unknown-attempt
 * watcher (possible double deliveries), stale dispute refresh, orphan-claim sweep.
 * Kuntanii gives a stable id per attempt, so sequential polling is enough.
 */
async function runKuntaniiSync(request: NextRequest) {
    const { authorized, errorResponse } = verifyCronAuth(request)
    if (!authorized && errorResponse) return errorResponse

    console.log("[CRON-KUNTANII] Starting status sync...")
    const statusSync = await phase("status-sync", syncStatuses)
    const unknownAttempts = await phase("unknown-attempts", () => checkUnknownAttempts())
    const disputesRefreshed = await phase("disputes-refresh", () => refreshStaleDisputes(20, 30 * 60_000))
    const orphanClaims = await phase("orphan-claims", () => sweepOrphanClaims(15 * 60_000, 20))

    const failed = [statusSync, unknownAttempts, disputesRefreshed, orphanClaims].some(
        (r) => typeof r === "object" && r !== null && "error" in r
    )
    return NextResponse.json({ success: !failed, statusSync, unknownAttempts, disputesRefreshed, orphanClaims })
}

async function syncStatuses() {
    const { data: pendingOrders, error: fetchError } = await supabase
        .from("mtn_fulfillment_tracking")
        .select("id, mtn_order_id, status, shop_order_id, order_id, api_order_id, order_type, recipient_phone, size_gb")
        .eq("provider", "kuntanii")
        .in("status", ["pending", "processing"])
        .gte("created_at", syncWindowStartIso())
        .order("created_at", { ascending: true })
        .limit(BATCH_SIZE)

    if (fetchError) {
        console.error("[CRON-KUNTANII] Error fetching orders:", fetchError)
        throw new Error("Failed to fetch orders")
    }

    let synced = 0
    let failed = 0
    const orders = pendingOrders ?? []
    console.log(`[CRON-KUNTANII] Found ${orders.length} orders to sync`)

    for (let i = 0; i < orders.length; i++) {
        const order = orders[i]

        try {
            const result = await checkMTNOrderStatus(order.mtn_order_id, "kuntanii")

            if (result.success && result.status) {
                const oldStatus = order.status
                const newStatus = result.status
                const statusPriority: Record<string, number> = { pending: 1, processing: 2, completed: 3, failed: 3, reversed: 4, abandoned: 4 }

                if ((statusPriority[newStatus] ?? 0) < (statusPriority[oldStatus] ?? 0)) {
                    console.log(`[CRON-KUNTANII] Skipping regression ${oldStatus} -> ${newStatus} for ${order.mtn_order_id}`)
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
                        // No recipient phone in the message: keep PII out of notification text.
                        const body = newStatus === "completed"
                            ? `Your ${order.size_gb ?? ""}GB data order has been delivered successfully.`
                            : `Your ${order.size_gb ?? ""}GB data order failed. Please contact support.`
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

                    console.log(`[CRON-KUNTANII] ${order.mtn_order_id}: ${oldStatus} -> ${newStatus}`)
                    synced++
                }
            } else {
                console.warn(`[CRON-KUNTANII] Failed to get status for ${order.mtn_order_id}:`, result.message)
                failed++
            }

            if (i < orders.length - 1) await sleep(DELAY_BETWEEN_REQUESTS_MS)
        } catch (err) {
            console.error(`[CRON-KUNTANII] Error processing ${order.mtn_order_id}:`, err)
            failed++
        }
    }

    let reversed = 0
    const reversalCandidates = await fetchReversalCandidates(supabase, "kuntanii", BATCH_SIZE)
    for (const cand of reversalCandidates) {
        const chk = await checkMTNOrderStatus((cand as any).mtn_order_id, "kuntanii")
        if (!chk.success || !chk.status) { await sleep(DELAY_BETWEEN_REQUESTS_MS); continue }
        if (isReversal({ trackingStatus: "completed", completedAt: (cand as any).updated_at, providerStatus: chk.status })) {
            await flagReversal(supabase, cand, { status: chk.order?.status ?? "failed", message: chk.message })
            reversed++
        }
        await sleep(DELAY_BETWEEN_REQUESTS_MS)
    }

    return { synced, failed, total: orders.length, reversed }
}
