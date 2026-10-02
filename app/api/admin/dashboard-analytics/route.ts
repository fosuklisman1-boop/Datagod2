import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

// Breakdown panels for the Admin Dashboard hub (Revenue by Network, By
// Product, By Source, Top Packages, Top Agents), scoped to the same
// Today/7D/30D range as get_admin_dashboard_hub_stats. Growth & Roles
// (new users / expiring / role mix) is always a live snapshot within
// the RPC itself, independent of `range`.
export async function GET(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    )

    const rangeParam = request.nextUrl.searchParams.get("range")
    const range = rangeParam === "today" || rangeParam === "30d" ? rangeParam : "7d"
    const { data, error } = await supabase.rpc("get_admin_dashboard_analytics", { p_range: range })
    if (error) {
      console.error("[ADMIN-DASHBOARD-ANALYTICS] RPC failed:", error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error("[ADMIN-DASHBOARD-ANALYTICS] Unexpected error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load dashboard analytics" },
      { status: 500 }
    )
  }
}
