import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"
import { verifyCronAuth } from "@/lib/cron-auth"
import { syncWindowStartIso } from "@/lib/status-sync-window"
import { backgroundCron } from "@/lib/cron-background"
import { fetchReversalCandidates, isReversal, flagReversal, REVERSAL_WINDOW_MS } from "@/lib/mtn-reversal"
import { applyHubnetStatusChange, type HubnetSyncRow } from "@/lib/hubnet/sync"
import { checkHubnetUnknownAttempts } from "@/lib/hubnet/unknown-attempts"
import { createHubnetClient, isHubnetConfigured } from "@/lib/hubnet/client"
import { isRefundSweepDue } from "@/lib/hubnet/sweep-schedule"
import { syncHubnetAirtime } from "@/lib/airtime-hubnet"
import { sweepHubnetRefunds } from "@/lib/hubnet/refund-sweep"
import { notifyAdminsThrottled } from "@/lib/sms/notify"
import type { HubnetStatus } from "@/lib/hubnet/core"
import { defaultHubnetCooldown } from "@/lib/hubnet/cooldown"
import { budgetedClient, lookupBudget, rotatingSlice, type LookupBudget } from "@/lib/hubnet/run-budget"

// Answer the scheduler at once (cron-job.org times out at 30s); the sync runs after the response.
export const GET = backgroundCron("sync-hubnet", (request) => runHubnetSync(request))

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

const BATCH_SIZE = 50
const DELAY_BETWEEN_REQUESTS_MS = 1500
/** The job runs every 5 minutes; successive runs look at successive slices of a backlog. */
const RUN_PERIOD_MS = 5 * 60_000

/** True when this run may make one more Hubnet status call (budget left and no shared 429 cooldown). */
async function mayCall(budget: LookupBudget): Promise<boolean> {
    if ((await defaultHubnetCooldown().remainingSec()) > 0) return false
    return budget.take()
}

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

    // Decided before any (possibly slow) phase so the sweep minute cannot slip past.
    const sweepDue = isRefundSweepDue(new Date())
    const configured = isHubnetConfigured()
    const notConfigured = { skipped: "not configured" }
    // A small lookup allowance per phase (8 per run in all), so new orders keep most of Hubnet's
    // rate limit and no phase starves another. A 429 in any phase trips the shared cooldown,
    // which stops every later phase too.
    const statusBudget = lookupBudget(5)
    const reversalBudget = lookupBudget(1)
    const unknownBudget = lookupBudget(1)
    const airtimeBudget = lookupBudget(1)
    const runIndex = Math.floor(Date.now() / RUN_PERIOD_MS)

    console.log("[CRON-HUBNET] Starting status sync...")
    // On due runs the refund sweep goes FIRST, ahead of the slow phases.
    const refundSweep = !configured
        ? notConfigured
        : sweepDue
            ? await phase("refund-sweep", () => sweepHubnetRefunds(supabase, createHubnetClient(), notifyAdminsThrottled))
            : { skipped: "not this minute" }
    const statusSync = await phase("status-sync", () => syncStatuses(statusBudget, runIndex))
    const reversals = await phase("reversals", () => syncReversals(reversalBudget))
    const unknownAttempts = !configured
        ? notConfigured
        : await phase("unknown-attempts", () => checkHubnetUnknownAttempts(supabase, budgetedClient(createHubnetClient(), unknownBudget)))
    const airtimeSync = !configured
        ? notConfigured
        : await phase("airtime-sync", () => syncHubnetAirtime(supabase, budgetedClient(createHubnetClient(), airtimeBudget)))
    const stopped = [statusBudget, reversalBudget, unknownBudget, airtimeBudget].some((b) => b.stopped)
    console.log(`[CRON-HUBNET] lookups done${stopped ? " (stopped early: Hubnet rate limit)" : ""}`)

    const failed = [statusSync, reversals, unknownAttempts, airtimeSync, refundSweep].some(
        (r) => typeof r === "object" && r !== null && "error" in r
    )
    return NextResponse.json({ success: !failed, statusSync, reversals, unknownAttempts, airtimeSync, refundSweep })
}

async function syncStatuses(budget: LookupBudget, runIndex: number) {
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
    let skipped = 0
    const all = pendingOrders ?? []
    // Only as many rows as this run can afford, rotating so the whole backlog gets covered.
    const orders = rotatingSlice(all, budget.left, runIndex)
    console.log(`[CRON-HUBNET] Found ${all.length} orders to sync, checking ${orders.length} this run`)

    for (let i = 0; i < orders.length; i++) {
        const order = orders[i]
        if (!(await mayCall(budget))) {
            skipped = orders.length - i
            break
        }

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

    return { synced, failed, skipped, checked: orders.length - skipped, total: all.length }
}

async function syncReversals(budget: LookupBudget) {
    let reversed = 0
    const candidates = await fetchReversalCandidates(supabase, "hubnet", BATCH_SIZE, {
        windowMs: REVERSAL_WINDOW_MS,
        rotateAt: new Date(),
    })
    for (const cand of candidates) {
        if (!(await mayCall(budget))) break
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
