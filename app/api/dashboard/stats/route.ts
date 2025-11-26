import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET() {
  try {
    console.log("Fetching dashboard stats...")

    // Get total orders
    const { data: allOrders, error: ordersError } = await supabase
      .from("shop_orders")
      .select("id, order_status")

    if (ordersError) {
      throw new Error(`Failed to fetch orders: ${ordersError.message}`)
    }

    const totalOrders = allOrders?.length || 0

    // Count by status
    let completed = 0
    let processing = 0
    let failed = 0
    let pending = 0

    allOrders?.forEach((order: any) => {
      if (order.order_status === "completed") completed++
      else if (order.order_status === "processing") processing++
      else if (order.order_status === "failed") failed++
      else if (order.order_status === "pending") pending++
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
