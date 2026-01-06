import { NextRequest, NextResponse } from "next/server"
import { checkMTNBalance } from "@/lib/mtn-fulfillment"
import { supabase } from "@/lib/supabase"

/**
 * GET /api/admin/fulfillment/mtn-balance
 * Check MTN wallet balance (admin only)
 */
export async function GET(request: NextRequest) {
  try {
    // Verify admin access
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: user, error: userError } = await supabase.auth.getUser(token)

    if (userError || !user?.user?.id) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 })
    }

    // Check if user is admin (users table)
    const { data: userData, error: userError2 } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.user.id)
      .single()

    if (userError2 || userData?.role !== "admin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    // Get MTN balance
    const balance = await checkMTNBalance()

    if (balance === null) {
      return NextResponse.json(
        { error: "Failed to fetch balance from MTN API" },
        { status: 502 }
      )
    }

    // Get alert threshold
    const { data: settingData } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "mtn_balance_alert_threshold")
      .single()

    const threshold = parseInt(settingData?.value || "500", 10)
    const isLow = balance < threshold

    return NextResponse.json({
      success: true,
      balance,
      currency: "GHS",
      threshold,
      is_low: isLow,
      alert: isLow ? `Balance is below threshold of ₵${threshold}` : null,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[MTN Balance] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
