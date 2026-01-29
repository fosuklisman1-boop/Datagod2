import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * GET /api/admin/fulfillment/mtn-logs
 * Fetch MTN fulfillment tracking logs
 */
export async function GET(request: NextRequest) {
  try {
    // Verify admin access
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status") || "all"
    const limit = parseInt(searchParams.get("limit") || "50")
    const offset = parseInt(searchParams.get("offset") || "0")

    // Build query
    let query = supabase
      .from("mtn_fulfillment_tracking")
      .select(`
        id,
        shop_order_id,
        order_id,
        order_type,
        mtn_order_id,
        status,
        recipient_phone,
        network,
        size_gb,
        external_status,
        external_message,
        retry_count,
        last_retry_at,
        created_at,
        updated_at,
        webhook_received_at,
        api_response_payload
      `, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    // Apply status filter
    if (status !== "all") {
      query = query.eq("status", status)
    }

    const { data, error, count } = await query

    if (error) {
      console.error("[MTN-LOGS] Error fetching logs:", error)
      return NextResponse.json(
        { error: "Failed to fetch logs" },
        { status: 500 }
      )
    }

    // Get summary counts using efficient exact count queries
    const [totalResult, pendingResult, processingResult, completedResult, failedResult, retryingResult] = await Promise.all([
      supabase.from("mtn_fulfillment_tracking").select("id", { count: "exact", head: true }),
      supabase.from("mtn_fulfillment_tracking").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("mtn_fulfillment_tracking").select("id", { count: "exact", head: true }).eq("status", "processing"),
      supabase.from("mtn_fulfillment_tracking").select("id", { count: "exact", head: true }).eq("status", "completed"),
      supabase.from("mtn_fulfillment_tracking").select("id", { count: "exact", head: true }).eq("status", "failed"),
      supabase.from("mtn_fulfillment_tracking").select("id", { count: "exact", head: true }).eq("status", "retrying")
    ])

    const summary = {
      total: totalResult.count || 0,
      pending: pendingResult.count || 0,
      processing: processingResult.count || 0,
      completed: completedResult.count || 0,
      failed: failedResult.count || 0,
      retrying: retryingResult.count || 0,
    }

    return NextResponse.json({
      success: true,
      logs: data || [],
      count: count || 0,
      summary,
      pagination: {
        limit,
        offset,
        hasMore: (count || 0) > offset + limit,
      },
    })
  } catch (error) {
    console.error("[MTN-LOGS] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
