import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// DataKazina API configuration
const DATAKAZINA_API_URL = process.env.DATAKAZINA_API_URL || "https://reseller.dakazinabusinessconsult.com/api/v1"
const DATAKAZINA_API_KEY = process.env.DATAKAZINA_API_KEY || ""

/**
 * GET /api/cron/sync-mtn-status/datakazina
 * 
 * Dedicated cron job for DataKazina MTN status syncing.
 * Uses individual polling to ensure high reliability.
 */
export async function GET(request: NextRequest) {
    try {
        console.log("[CRON-DATAKAZINA] Starting status sync...")

        // 1. Get all pending/processing DataKazina orders
        const { data: pendingOrders, error: fetchError } = await supabase
            .from("mtn_fulfillment_tracking")
            .select("id, mtn_order_id, status, shop_order_id, order_id, order_type")
            .eq("provider", "datakazina")
            .in("status", ["pending", "processing"])
            .order("created_at", { ascending: true })
            .limit(50)

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
        const results = []

        // 2. Poll each order individually for the most accurate status
        for (const order of pendingOrders) {
            try {
                console.log(`[CRON-DATAKAZINA] Syncing order ${order.mtn_order_id}...`)

                const result = await checkMTNOrderStatus(order.mtn_order_id, "datakazina")

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
                    debug: result.order
                })
            } catch (err) {
                console.error(`[CRON-DATAKAZINA] Error processing ${order.mtn_order_id}:`, err)
                failed++
            }
        }

        return NextResponse.json({
            success: true,
            synced,
            failed,
            total: pendingOrders.length,
            results
        })
    } catch (error) {
        console.error("[CRON-DATAKAZINA] Critical error:", error)
        return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
}
