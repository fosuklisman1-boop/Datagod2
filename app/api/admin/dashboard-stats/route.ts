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

    // Use RPC for all heavy calculations including airtime
    const { data: stats, error: rpcError } = await supabase.rpc("get_admin_dashboard_stats_v2")

    if (rpcError) {
      console.error("[ADMIN-STATS] RPC Error:", rpcError)
      return NextResponse.json(
        { error: "Failed to fetch dashboard stats. Please ensure migrations are run." },
        { status: 500 }
      )
    }

    const airtimeStats = {
      totalAirtimeOrders: stats.airtimeTotalOrders || 0,
      completedAirtimeOrders: stats.airtimeCompletedOrders || 0,
      airtimeRevenue: stats.airtimeRevenue || 0
    }

    return NextResponse.json(
      {
        ...stats,
        totalOrders: stats.totalOrders + airtimeStats.totalAirtimeOrders,
        completedOrders: stats.completedOrders + airtimeStats.completedAirtimeOrders,
        totalRevenue: stats.totalRevenue + airtimeStats.airtimeRevenue,
        airtimeStats,
        successRate: (stats.totalOrders + airtimeStats.totalAirtimeOrders) 
          ? (((stats.completedOrders + airtimeStats.completedAirtimeOrders) / (stats.totalOrders + airtimeStats.totalAirtimeOrders)) * 100).toFixed(2) 
          : 0,
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
