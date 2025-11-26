import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET() {
  try {
    console.log("Fetching dashboard stats...")

    // Get all user orders (from regular orders table, not shop_orders)
    const { data: allOrders, error: ordersError } = await supabase
      .from("orders")
      .select("id, status")

    if (ordersError) {
      console.warn(`Note: Could not fetch from orders table: ${ordersError.message}`)
      // Fall back to empty data instead of failing
      const fallbackStats = {
        totalOrders: 0,
        completed: 0,
        processing: 0,
        failed: 0,
        pending: 0,
        successRate: "0%"
      }
      console.log(`Stats: Total=0 (fallback)`)
      return NextResponse.json({
        success: true,
        stats: fallbackStats
      })
    }

    const totalOrders = allOrders?.length || 0

    // Count by status
    let completed = 0
    let processing = 0
    let failed = 0
    let pending = 0

    allOrders?.forEach((order: any) => {
      if (order.status === "completed") completed++
      else if (order.status === "processing") processing++
      else if (order.status === "failed") failed++
      else if (order.status === "pending") pending++
    })

    const successRate = totalOrders > 0 ? ((completed / totalOrders) * 100).toFixed(0) : 0

    console.log(`Stats: Total=${totalOrders}, Completed=${completed}, Processing=${processing}, Failed=${failed}, Pending=${pending}`)

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
    console.error("Error fetching dashboard stats:", error)
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
