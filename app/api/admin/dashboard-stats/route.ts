import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export async function GET(request: NextRequest) {
  try {
    // Verify admin access (checks both user_metadata and users table)
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    )

    // Use RPC for all heavy calculations
    const { data: stats, error: rpcError } = await supabase.rpc("get_admin_dashboard_stats")

    if (rpcError) {
      console.error("[ADMIN-STATS] RPC Error:", rpcError)
      throw rpcError
    }

    return NextResponse.json(
      {
        ...stats,
        successRate: stats.totalOrders ? (((stats.completedOrders / stats.totalOrders) * 100).toFixed(2)) : 0,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("[ADMIN-STATS] Unexpected error:", error)
    return NextResponse.json(
      { error: "Failed to fetch dashboard stats" },
      { status: 500 }
    )
  }
}
