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
    const { tracking_id, mtn_order_id, sync_all_pending, provider } = body

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

    // Option 2: Check status by MTN order ID directly (for debugging)
    if (mtn_order_id) {
      console.log(`[SYNC-STATUS] Checking MTN order ${mtn_order_id} directly from API (provider: ${provider || "default"})`)
      const result = await checkMTNOrderStatus(mtn_order_id, provider)

      console.log(`[SYNC-STATUS] Direct API check result:`, JSON.stringify(result, null, 2))

      return NextResponse.json({
        success: result.success,
        status: result.status,
        message: result.message,
        order: result.order,
        debug: {
          rawStatus: result.order?.status,
          normalizedStatus: result.status,
        }
      })
    }

    // Option 3: Sync all pending orders (optionally filtered by provider)
    if (sync_all_pending) {
      const syncProvider = body.sync_provider as string | undefined
      console.log(`[SYNC-STATUS] Syncing pending MTN orders${syncProvider ? ` (provider: ${syncProvider})` : ""}`)

      // AgentPortalGH's queue auto-retries a failed item internally up to 3x
      // (§8), often as a separate webhook delivery per attempt — a "failed" row
      // there isn't necessarily final, unlike other providers. Include recent
      // failed AgentPortalGH rows so this manual sync can actually recover them.
      const statuses = syncProvider === "agentportalgh" ? ["pending", "processing", "failed"] : ["pending", "processing"]
      const RECHECK_FAILED_WINDOW_H = 24
      const failedCutoffIso = new Date(Date.now() - RECHECK_FAILED_WINDOW_H * 60 * 60 * 1000).toISOString()

      let dbQuery = supabase
        .from("mtn_fulfillment_tracking")
        .select("id, mtn_order_id, status, created_at")
        .in("status", statuses)
        .order("created_at", { ascending: false })
        .limit(200)

      if (syncProvider) {
        dbQuery = dbQuery.eq("provider", syncProvider)
      }

      const { data: rawOrders, error } = await dbQuery

      if (error) {
        return NextResponse.json(
          { error: "Failed to fetch pending orders" },
          { status: 500 }
        )
      }

      // A "failed" row only qualifies if it's recent enough to plausibly still
      // be mid-retry on AgentPortalGH's side.
      const pendingOrders = (rawOrders ?? []).filter(
        o => o.status !== "failed" || o.created_at >= failedCutoffIso
      )

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
