import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"
import { verifyCronAuth } from "@/lib/cron-auth"
import { syncWindowStartIso } from "@/lib/status-sync-window"
import { backgroundCron } from "@/lib/cron-background"
import { fetchReversalCandidates, isReversal, flagReversal, REVERSAL_WINDOW_MS } from "@/lib/mtn-reversal"
import { applyHubnetStatusChange, type HubnetSyncRow } from "@/lib/hubnet/sync"
import { checkHubnetUnknownAttempts } from "@/lib/hubnet/unknown-attempts"
import { createHubnetClient } from "@/lib/hubnet/client"
import { syncHubnetAirtime } from "@/lib/airtime-hubnet"
import { sweepHubnetRefunds } from "@/lib/hubnet/refund-sweep"
import { notifyAdminsThrottled } from "@/lib/sms/notify"
import type { HubnetStatus } from "@/lib/hubnet/core"

// Answer the scheduler at once (cron-job.org times out at 30s); the sync runs after the response.
export const GET = backgroundCron("sync-hubnet", (request) => runHubnetSync(request))

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
        console.error(`[CRON-HUBNET] ${name} phase failed:`, err instanceof Error ? err.message : err)
        return { error: "phase failed" }
    }
}

/**
 * GET /api/cron/sync-mtn-status/hubnet
 *
 * Safety net for Hubnet orders whose webhook was missed, then the unknown-attempt
 * watcher (possible double deliveries), then airtime-sync (processing Hubnet airtime
 * orders) and the refund sweep, which runs every 10th minute.
 */
async function runHubnetSync(request: NextRequest) {
    const { authorized, errorResponse } = verifyCronAuth(request)
    if (!authorized && errorResponse) return errorResponse

    console.log("[CRON-HUBNET] Starting status sync...")
    const statusSync = await phase("status-sync", syncStatuses)
    const reversals = await phase("reversals", syncReversals)
    const unknownAttempts = await phase("unknown-attempts", () =>
        checkHubnetUnknownAttempts(supabase, createHubnetClient()))
    const airtimeSync = await phase("airtime-sync", () => syncHubnetAirtime(supabase, createHubnetClient()))
    // Refund sweep runs only on every 10th minute.
    const refundSweep = await phase("refund-sweep", async () =>
        new Date().getUTCMinutes() % 10 === 0
            ? sweepHubnetRefunds(supabase, createHubnetClient(), notifyAdminsThrottled)
            : { skipped: "not this minute" })

    const failed = [statusSync, reversals, unknownAttempts, airtimeSync, refundSweep].some(
        (r) => typeof r === "object" && r !== null && "error" in r
    )
    return NextResponse.json({ success: !failed, statusSync, reversals, unknownAttempts, airtimeSync, refundSweep })
}

async function syncStatuses() {
    const { data: pendingOrders, error: fetchError } = await supabase
        .from("mtn_fulfillment_tracking")
        .select("id, mtn_order_id, status, shop_order_id, order_id, api_order_id, order_type, recipient_phone, size_gb")
        .eq("provider", "hubnet")
        .in("status", ["pending", "processing"])
        .not("mtn_order_id", "like", "UNKNOWN_%")
        .gte("created_at", syncWindowStartIso())
        .order("created_at", { ascending: true })
        .limit(BATCH_SIZE)

    if (fetchError) {
        console.error("[CRON-HUBNET] Error fetching orders:", fetchError)
        throw new Error("Failed to fetch orders")
    }

    let synced = 0
    let failed = 0
    const orders = pendingOrders ?? []
    console.log(`[CRON-HUBNET] Found ${orders.length} orders to sync`)

    for (let i = 0; i < orders.length; i++) {
        const order = orders[i]

        try {
            const result = await checkMTNOrderStatus(order.mtn_order_id, "hubnet")

            if (result.success && result.status) {
                const oldStatus = order.status
                const newStatus = result.status
                const statusPriority: Record<string, number> = { pending: 1, processing: 2, completed: 3, failed: 3, reversed: 4, abandoned: 4 }

                if ((statusPriority[newStatus] ?? 0) < (statusPriority[oldStatus] ?? 0)) {
                    console.log(`[CRON-HUBNET] Skipping regression ${oldStatus} -> ${newStatus} for ${order.mtn_order_id}`)
                } else if (newStatus !== oldStatus) {
                    // Guarded on oldStatus: an overlapping run / webhook sync that already moved the row wins.
                    const applied = await applyHubnetStatusChange(supabase, order as HubnetSyncRow, newStatus as HubnetStatus, result)
                    if (applied) {
                        console.log(`[CRON-HUBNET] ${order.mtn_order_id}: ${oldStatus} -> ${newStatus}`)
                        synced++
                    } else {
                        console.log(`[CRON-HUBNET] ${order.mtn_order_id}: already moved from ${oldStatus} by another run, skipping`)
                    }
                }
            } else {
                console.warn(`[CRON-HUBNET] Failed to get status for ${order.mtn_order_id}:`, result.message)
                failed++
            }

            if (i < orders.length - 1) await sleep(DELAY_BETWEEN_REQUESTS_MS)
        } catch (err) {
            console.error(`[CRON-HUBNET] Error processing ${order.mtn_order_id}:`, err)
            failed++
        }
    }

    return { synced, failed, total: orders.length }
}

async function syncReversals() {
    let reversed = 0
    const candidates = await fetchReversalCandidates(supabase, "hubnet", BATCH_SIZE, {
        windowMs: REVERSAL_WINDOW_MS,
        rotateAt: new Date(),
    })
    for (const cand of candidates) {
        const chk = await checkMTNOrderStatus((cand as any).mtn_order_id, "hubnet")
        if (!chk.success || !chk.status) { await sleep(DELAY_BETWEEN_REQUESTS_MS); continue }
        if (isReversal({ trackingStatus: "completed", completedAt: (cand as any).updated_at, providerStatus: chk.status, windowMs: REVERSAL_WINDOW_MS })) {
            await flagReversal(supabase, cand, { status: chk.order?.status ?? "failed", message: chk.message })
            reversed++
        }
        await sleep(DELAY_BETWEEN_REQUESTS_MS)
    }
    return { reversed, total: candidates.length }
}
