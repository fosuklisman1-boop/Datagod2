import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

// All-time breakdown panels for the Admin Dashboard hub (Revenue by Network,
// Growth & Roles, By Product, By Source, Top Packages, Top Agents).
// Deliberately not range-scoped -- these are lifetime composition panels,
// separate from get_admin_dashboard_hub_stats' Today/7D/30D toggle.
export async function GET(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    )

    const { data, error } = await supabase.rpc("get_admin_dashboard_analytics")
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
