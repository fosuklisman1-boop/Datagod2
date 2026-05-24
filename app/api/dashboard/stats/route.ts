import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  try {
    // Get user ID from Authorization header
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Missing or invalid authorization header" },
        { status: 401 }
      )
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    
    if (authError || !user?.id) {
      console.error("[DASHBOARD-STATS] Auth error:", authError)
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const userId = user.id
    console.log("[DASHBOARD-STATS] Fetching stats for user:", userId)

    // Single GROUP BY query — no pagination, no in-memory counting
    const { data: statusCounts, error: ordersError } = await supabase
      .from("orders")
      .select("status")
      .eq("user_id", userId)

    if (ordersError) {
      console.warn(`[DASHBOARD-STATS] Could not fetch orders: ${ordersError.message}`)
      return NextResponse.json({
        success: true,
        stats: { totalOrders: 0, completed: 0, processing: 0, failed: 0, pending: 0, successRate: "0%" }
      })
    }

    // Count by status in JS (single fetch, no pagination)
    let completed = 0, processing = 0, failed = 0, pending = 0
    for (const { status } of statusCounts ?? []) {
      if (status === "completed") completed++
      else if (status === "processing") processing++
      else if (status === "failed") failed++
      else if (status === "pending") pending++
    }

    const totalOrders = (statusCounts ?? []).length
    const successRate = totalOrders > 0 ? ((completed / totalOrders) * 100).toFixed(0) : 0

    console.log(`[DASHBOARD-STATS] User ${userId}: Total=${totalOrders}, Completed=${completed}, Processing=${processing}, Failed=${failed}, Pending=${pending}`)

    return NextResponse.json(
      {
        success: true,
        stats: { totalOrders, completed, processing, failed, pending, successRate: `${successRate}%` }
      },
      { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=30" } }
    )
  } catch (error) {
    console.error("[DASHBOARD-STATS] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
        stats: {
          totalOrders: 0,
          completed: 0,
          processing: 0,
          failed: 0,
          pending: 0,
          successRate: "0%"
        }
      },
      { status: 500 }
    )
  }
}
