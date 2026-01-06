import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { checkMTNOrderStatus, syncMTNOrderStatus } from "@/lib/mtn-fulfillment"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * POST /api/admin/fulfillment/sync-status
 * Sync MTN order status from Sykes API
 */
export async function POST(request: NextRequest) {
  try {
    // Verify admin access
    const adminCheck = await verifyAdminAccess(request)
    if (!adminCheck.isAdmin) {
      return adminCheck.errorResponse!
    }

    const body = await request.json()
    const { tracking_id, mtn_order_id, sync_all_pending } = body

    // Option 1: Sync a specific tracking record
    if (tracking_id) {
      console.log(`[SYNC-STATUS] Syncing tracking record ${tracking_id}`)
      const result = await syncMTNOrderStatus(tracking_id)
      
      return NextResponse.json({
        success: result.success,
        message: result.message,
        newStatus: result.newStatus,
      })
    }

    // Option 2: Check status by MTN order ID directly
    if (mtn_order_id) {
      console.log(`[SYNC-STATUS] Checking MTN order ${mtn_order_id}`)
      const result = await checkMTNOrderStatus(mtn_order_id)
      
      return NextResponse.json({
        success: result.success,
        status: result.status,
        message: result.message,
        order: result.order,
      })
    }

    // Option 3: Sync all pending orders
    if (sync_all_pending) {
      console.log(`[SYNC-STATUS] Syncing all pending MTN orders`)
      
      const { data: pendingOrders, error } = await supabase
        .from("mtn_fulfillment_tracking")
        .select("id, mtn_order_id")
        .in("status", ["pending", "processing"])
        .order("created_at", { ascending: false })
        .limit(50)

      if (error) {
        return NextResponse.json(
          { error: "Failed to fetch pending orders" },
          { status: 500 }
        )
      }

      const results = []
      for (const order of pendingOrders || []) {
        const result = await syncMTNOrderStatus(order.id)
        results.push({
          tracking_id: order.id,
          mtn_order_id: order.mtn_order_id,
          ...result,
        })
      }

      const updated = results.filter(r => r.success && r.newStatus !== "pending").length
      const unchanged = results.filter(r => r.success && r.newStatus === "pending").length
      const failed = results.filter(r => !r.success).length

      return NextResponse.json({
        success: true,
        message: `Synced ${pendingOrders?.length || 0} orders: ${updated} updated, ${unchanged} unchanged, ${failed} failed`,
        total: pendingOrders?.length || 0,
        updated,
        unchanged,
        failed,
        results,
      })
    }

    return NextResponse.json(
      { error: "Missing required parameter: tracking_id, mtn_order_id, or sync_all_pending" },
      { status: 400 }
    )
  } catch (error) {
    console.error("[SYNC-STATUS] Error:", error)
    return NextResponse.json(
      { error: "Failed to sync status", details: error instanceof Error ? error.message : "" },
      { status: 500 }
    )
  }
}
