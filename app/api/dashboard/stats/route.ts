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

    // Get user's orders with pagination (from regular orders table, not shop_orders)
    let userOrders: any[] = []
    let offset = 0
    const batchSize = 1000
    let hasMore = true
    let ordersError = null

    while (hasMore) {
      const { data, error } = await supabase
        .from("orders")
        .select("id, status")
        .eq("user_id", userId)
        .range(offset, offset + batchSize - 1)

      if (error) {
        ordersError = error
        break
      }

      if (data && data.length > 0) {
        userOrders = userOrders.concat(data)
        offset += batchSize
        hasMore = data.length === batchSize
      } else {
        hasMore = false
      }
    }

    if (ordersError) {
      console.warn(`[DASHBOARD-STATS] Could not fetch orders: ${ordersError.message}`)
      const fallbackStats = {
        totalOrders: 0,
        completed: 0,
        processing: 0,
        failed: 0,
        pending: 0,
        successRate: "0%"
      }
      return NextResponse.json({
        success: true,
        stats: fallbackStats
      })
    }

    const totalOrders = userOrders.length

    // Count by status
    let completed = 0
    let processing = 0
    let failed = 0
    let pending = 0

    userOrders.forEach((order: any) => {
      if (order.status === "completed") completed++
      else if (order.status === "processing") processing++
      else if (order.status === "failed") failed++
      else if (order.status === "pending") pending++
    })

    const successRate = totalOrders > 0 ? ((completed / totalOrders) * 100).toFixed(0) : 0

    console.log(`[DASHBOARD-STATS] User ${userId}: Total=${totalOrders}, Completed=${completed}, Processing=${processing}, Failed=${failed}, Pending=${pending}`)

    return NextResponse.json({
      success: true,
      stats: {
        totalOrders,
        completed,
        processing,
        failed,
        pending,
        successRate: `${successRate}%`
      }
    })
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
