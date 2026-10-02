import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export async function GET(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    )

    // Range-scoped hub stats (revenue/profit/orders/chart/actions) for the
    // redesigned dashboard hub -- additive, merged into whichever payload
    // shape below ends up returned so the existing all-time fields (and the
    // get_admin_stats AI tool, which reads this same route) are untouched.
    const rangeParam = request.nextUrl.searchParams.get("range")
    const range = rangeParam === "today" || rangeParam === "30d" ? rangeParam : "7d"
    const { data: hubStats, error: hubError } = await supabase.rpc("get_admin_dashboard_hub_stats", { p_range: range })
    if (hubError) {
      console.error("[ADMIN-STATS] hub stats RPC failed:", hubError.message)
    }

    // Try optimized v2 RPC first (requires optimize_admin_stats.sql to be run in Supabase)
    const { data: statsV2, error: rpcV2Error } = await supabase.rpc("get_admin_dashboard_stats_v2")

    if (!rpcV2Error && statsV2) {
      // v2 RPC available — airtime stats already included
      const airtimeStats = {
        totalAirtimeOrders: statsV2.airtimeTotalOrders || 0,
        completedAirtimeOrders: statsV2.airtimeCompletedOrders || 0,
        airtimeRevenue: statsV2.airtimeRevenue || 0,
      }
      const totalOrders    = (statsV2.totalOrders || 0) + airtimeStats.totalAirtimeOrders
      const completedOrders = (statsV2.completedOrders || 0) + airtimeStats.completedAirtimeOrders
      return NextResponse.json({
        ...statsV2,
        ...(hubStats || {}),
        totalOrders,
        completedOrders,
        totalRevenue: (statsV2.totalRevenue || 0) + airtimeStats.airtimeRevenue,
        airtimeStats,
        successRate: totalOrders
          ? (((completedOrders) / totalOrders) * 100).toFixed(2)
          : 0,
      }, { status: 200 })
    }

    // --- Fallback: v2 not available, use v1 + separate airtime query ---
    console.warn("[ADMIN-STATS] v2 RPC not available, falling back to v1:", rpcV2Error?.message)

    const { data: stats, error: rpcError } = await supabase.rpc("get_admin_dashboard_stats")

    if (rpcError) {
      console.error("[ADMIN-STATS] v1 RPC also failed:", rpcError)
      return NextResponse.json(
        { error: "Failed to fetch dashboard stats" },
        { status: 500 }
      )
    }

    // Fetch airtime stats separately (limited to avoid timeout)
    const { data: airtimeData } = await supabase
      .from("airtime_orders")
      .select("status, total_paid")
      .limit(10000)

    const airtimeStats = (airtimeData || []).reduce((acc: any, order: any) => {
      acc.totalAirtimeOrders++
      if (order.status === "completed") {
        acc.completedAirtimeOrders++
        acc.airtimeRevenue += (order.total_paid || 0)
      }
      return acc
    }, { totalAirtimeOrders: 0, completedAirtimeOrders: 0, airtimeRevenue: 0 })

    const totalOrders = (stats.totalOrders || 0) + airtimeStats.totalAirtimeOrders
    const completedOrders = (stats.completedOrders || 0) + airtimeStats.completedAirtimeOrders

    return NextResponse.json(
      {
        ...stats,
        ...(hubStats || {}),
        totalOrders,
        completedOrders,
        totalRevenue: (stats.totalRevenue || 0) + airtimeStats.airtimeRevenue,
        airtimeStats,
        successRate: totalOrders
          ? (((completedOrders) / totalOrders) * 100).toFixed(2)
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
