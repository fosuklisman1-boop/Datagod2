import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// DataKazina API configuration
const DATAKAZINA_API_URL = process.env.DATAKAZINA_API_URL || "https://reseller.dakazinabusinessconsult.com/api/v1"
const DATAKAZINA_API_KEY = process.env.DATAKAZINA_API_KEY || ""

// Rate limiting configuration (prevent 429 errors)
const BATCH_SIZE = 10 // Process 10 orders at a time (reduced from 50)
const DELAY_BETWEEN_REQUESTS_MS = 2000 // 2 second delay between each status check
const DELAY_ON_429_MS = 10000 // 10 second delay if we hit rate limit

/**
 * Sleep helper function
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * GET /api/cron/sync-mtn-status/datakazina
 * 
 * Dedicated cron job for DataKazina MTN status syncing.
 * Uses individual polling to ensure high reliability.
 */
export async function GET(request: NextRequest) {
    try {
        console.log("[CRON-DATAKAZINA] Starting status sync...")

        // 1. Get all pending/processing DataKazina orders (limited batch)
        const { data: pendingOrders, error: fetchError } = await supabase
            .from("mtn_fulfillment_tracking")
            .select("id, mtn_order_id, status, shop_order_id, order_id, order_type")
            .eq("provider", "datakazina")
            .in("status", ["pending", "processing"])
            .order("created_at", { ascending: true })
            .limit(BATCH_SIZE)

        if (fetchError) {
            console.error("[CRON-DATAKAZINA] Error fetching orders:", fetchError)
            return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
        }

        if (!pendingOrders || pendingOrders.length === 0) {
            return NextResponse.json({ success: true, message: "No DataKazina orders to sync" })
        }

        console.log(`[CRON-DATAKAZINA] Found ${pendingOrders.length} orders to sync`)

        let synced = 0
        let failed = 0
        let rateLimited = 0
        const results = []

        // 2. Poll each order individually with rate limiting
        for (let i = 0; i < pendingOrders.length; i++) {
            const order = pendingOrders[i]

            try {
                console.log(`[CRON-DATAKAZINA] Syncing order ${i + 1}/${pendingOrders.length}: ${order.mtn_order_id}...`)

                const result = await checkMTNOrderStatus(order.mtn_order_id, "datakazina")

                // Check if we hit rate limit (429 error)
                if (!result.success && result.message?.includes("429")) {
                    console.warn(`[CRON-DATAKAZINA] ⚠️ Rate limited on order ${order.mtn_order_id}, waiting ${DELAY_ON_429_MS}ms...`)
                    rateLimited++
                    failed++

                    results.push({
                        id: order.id,
                        mtn_order_id: order.mtn_order_id,
                        success: false,
                        status: order.status,
                        message: "Rate limited - will retry later",
                    })

                    // Wait longer if rate limited, then continue
                    await sleep(DELAY_ON_429_MS)
                    continue
                }

                if (result.success && result.status) {
                    const oldStatus = order.status
                    const newStatus = result.status

                    if (newStatus !== oldStatus) {
                        // Update tracking record
                        await supabase
                            .from("mtn_fulfillment_tracking")
                            .update({
                                status: newStatus,
                                external_status: result.order?.status || newStatus,
                                external_message: result.message,
                                updated_at: new Date().toISOString()
                            })
                            .eq("id", order.id)

                        // Update original order record
                        if (order.order_type === "bulk" && order.order_id) {
                            await supabase.from("orders").update({ status: newStatus }).eq("id", order.order_id)
                        } else if (order.shop_order_id) {
                            await supabase.from("shop_orders").update({ order_status: newStatus }).eq("id", order.shop_order_id)
                        }

                        console.log(`[CRON-DATAKAZINA] ✅ Order ${order.mtn_order_id} updated: ${oldStatus} -> ${newStatus}`)
                        synced++
                    } else {
                        console.log(`[CRON-DATAKAZINA] Order ${order.mtn_order_id} status unchanged (${newStatus})`)
                    }
                } else {
                    console.warn(`[CRON-DATAKAZINA] ⚠️ Failed to get status for ${order.mtn_order_id}:`, result.message)
                    failed++
                }

                results.push({
                    id: order.id,
                    mtn_order_id: order.mtn_order_id,
                    success: result.success,
                    status: result.status || order.status,
                    message: result.message,
                })

                // Add delay between requests to avoid rate limiting (skip on last item)
                if (i < pendingOrders.length - 1) {
                    console.log(`[CRON-DATAKAZINA] Waiting ${DELAY_BETWEEN_REQUESTS_MS}ms before next request...`)
                    await sleep(DELAY_BETWEEN_REQUESTS_MS)
                }
            } catch (err) {
                console.error(`[CRON-DATAKAZINA] Error processing ${order.mtn_order_id}:`, err)
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
            config: {
                batchSize: BATCH_SIZE,
                delayBetweenRequests: DELAY_BETWEEN_REQUESTS_MS,
            }
        })
    } catch (error) {
        console.error("[CRON-DATAKAZINA] Critical error:", error)
        return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
}
