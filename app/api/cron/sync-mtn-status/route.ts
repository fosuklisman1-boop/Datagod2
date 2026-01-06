import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// Cron secret to prevent unauthorized access
const CRON_SECRET = process.env.CRON_SECRET

/**
 * GET /api/cron/sync-mtn-status
 * 
 * Cron job to sync MTN order statuses from Sykes API.
 * Should be called periodically (e.g., every 5 minutes).
 * 
 * Vercel Cron: Add to vercel.json
 * External Cron: Use cron-job.org or similar with CRON_SECRET header
 */
export async function GET(request: NextRequest) {
  try {
    // Verify cron secret (skip in development)
    const authHeader = request.headers.get("authorization")
    const cronSecret = authHeader?.replace("Bearer ", "")
    
    if (process.env.NODE_ENV === "production" && CRON_SECRET && cronSecret !== CRON_SECRET) {
      console.log("[CRON] Unauthorized cron request")
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    console.log("[CRON] Starting MTN status sync...")

    // Get all pending and processing orders
    const { data: pendingOrders, error: fetchError } = await supabase
      .from("mtn_fulfillment_tracking")
      .select("id, mtn_order_id, status, shop_order_id, order_id, order_type")
      .in("status", ["pending", "processing"])
      .not("mtn_order_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(50) // Process in batches to avoid timeout

    if (fetchError) {
      console.error("[CRON] Error fetching pending orders:", fetchError)
      return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
    }

    if (!pendingOrders || pendingOrders.length === 0) {
      console.log("[CRON] No pending/processing orders to sync")
      return NextResponse.json({ 
        success: true, 
        message: "No orders to sync",
        synced: 0 
      })
    }

    console.log(`[CRON] Found ${pendingOrders.length} orders to sync`)

    let synced = 0
    let failed = 0
    const results: Array<{ id: string; mtn_order_id: number; oldStatus: string; newStatus: string | null; error?: string }> = []

    for (const order of pendingOrders) {
      try {
        // Check status from Sykes API
        const statusResult = await checkMTNOrderStatus(order.mtn_order_id)

        if (!statusResult.success || !statusResult.status) {
          console.log(`[CRON] Failed to get status for order ${order.mtn_order_id}: ${statusResult.message}`)
          results.push({ 
            id: order.id, 
            mtn_order_id: order.mtn_order_id, 
            oldStatus: order.status, 
            newStatus: null,
            error: statusResult.message 
          })
          failed++
          continue
        }

        // If status changed, update the database
        if (statusResult.status !== order.status) {
          const newStatus = statusResult.status

          // Update tracking table
          await supabase
            .from("mtn_fulfillment_tracking")
            .update({
              status: newStatus,
              external_status: statusResult.order?.status,
              external_message: statusResult.order?.message,
              updated_at: new Date().toISOString(),
            })
            .eq("id", order.id)

          // Update corresponding order table
          if (order.order_type === "bulk" && order.order_id) {
            await supabase
              .from("orders")
              .update({
                status: newStatus,
                updated_at: new Date().toISOString(),
              })
              .eq("id", order.order_id)
          } else if (order.shop_order_id) {
            await supabase
              .from("shop_orders")
              .update({
                order_status: newStatus,
                updated_at: new Date().toISOString(),
              })
              .eq("id", order.shop_order_id)
          }

          console.log(`[CRON] Updated order ${order.mtn_order_id}: ${order.status} -> ${newStatus}`)
          results.push({ 
            id: order.id, 
            mtn_order_id: order.mtn_order_id, 
            oldStatus: order.status, 
            newStatus 
          })
          synced++
        } else {
          // Status unchanged
          results.push({ 
            id: order.id, 
            mtn_order_id: order.mtn_order_id, 
            oldStatus: order.status, 
            newStatus: order.status 
          })
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200))
      } catch (err) {
        console.error(`[CRON] Error processing order ${order.mtn_order_id}:`, err)
        results.push({ 
          id: order.id, 
          mtn_order_id: order.mtn_order_id, 
          oldStatus: order.status, 
          newStatus: null,
          error: err instanceof Error ? err.message : "Unknown error" 
        })
        failed++
      }
    }

    console.log(`[CRON] Sync complete: ${synced} updated, ${failed} failed, ${pendingOrders.length - synced - failed} unchanged`)

    return NextResponse.json({
      success: true,
      message: `Synced ${pendingOrders.length} orders`,
      total: pendingOrders.length,
      synced,
      failed,
      unchanged: pendingOrders.length - synced - failed,
      results,
    })
  } catch (error) {
    console.error("[CRON] Error in sync-mtn-status:", error)
    return NextResponse.json(
      { error: "Internal server error", details: error instanceof Error ? error.message : "" },
      { status: 500 }
    )
  }
}
