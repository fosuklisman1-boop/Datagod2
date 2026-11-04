import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"
import { verifyCronAuth } from "@/lib/cron-auth"
import { syncWindowStartIso } from "@/lib/status-sync-window"
import { backgroundCron } from "@/lib/cron-background"
import { fetchReversalCandidates, isReversal, flagReversal } from "@/lib/mtn-reversal"
import { checkUnknownAttempts } from "@/lib/mtn-providers/kuntanii-unknown-attempts"
import { refreshStaleDisputes, sweepOrphanClaims } from "@/lib/mtn-providers/kuntanii-disputes"
import { applyKuntaniiStatusChange, type KuntaniiSyncRow } from "@/lib/mtn-providers/kuntanii-sync"

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
                    // Guarded on oldStatus: an overlapping run / webhook sync that already moved the row wins.
                    const applied = await applyKuntaniiStatusChange(supabase, order as KuntaniiSyncRow, newStatus, result)
                    if (applied) {
                        console.log(`[CRON-KUNTANII] ${order.mtn_order_id}: ${oldStatus} -> ${newStatus}`)
                        synced++
                    } else {
                        console.log(`[CRON-KUNTANII] ${order.mtn_order_id}: already moved from ${oldStatus} by another run, skipping`)
                    }
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
