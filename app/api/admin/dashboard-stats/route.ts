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

    // Fetch airtime stats separately and merge
    const { data: airtimeData, error: airtimeError } = await supabase
      .from("airtime_orders")
      .select("status, total_paid")

    const airtimeStats = (airtimeData || []).reduce((acc, order) => {
      acc.totalAirtimeOrders++
      if (order.status === 'completed') {
        acc.completedAirtimeOrders++
        acc.airtimeRevenue += (order.total_paid || 0)
      }
      return acc
    }, { totalAirtimeOrders: 0, completedAirtimeOrders: 0, airtimeRevenue: 0 })

    return NextResponse.json(
      {
        ...stats,
        totalOrders: stats.totalOrders + airtimeStats.totalAirtimeOrders,
        completedOrders: stats.completedOrders + airtimeStats.completedAirtimeOrders,
        totalRevenue: stats.totalRevenue + airtimeStats.airtimeRevenue,
        airtimeStats, // Optional: send detailed airtime stats too
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
