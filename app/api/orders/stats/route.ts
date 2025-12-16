import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = user.id

    // Get all order status counts in a single query
    const { data: orders, error: ordersError } = await supabase
      .from("orders")
      .select("status", { count: "exact" })
      .eq("user_id", userId)

    if (ordersError) {
      console.error("Error fetching orders:", ordersError)
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      )
    }

    // Count statuses locally instead of making 5 separate queries
    const statusCounts = {
      total: orders?.length || 0,
      completed: 0,
      processing: 0,
      failed: 0,
      pending: 0,
    }

    orders?.forEach((order: any) => {
      switch (order.status) {
        case "completed":
          statusCounts.completed++
          break
        case "processing":
          statusCounts.processing++
          break
        case "failed":
          statusCounts.failed++
          break
        case "pending":
          statusCounts.pending++
          break
      }
    })

    const successRate = statusCounts.total > 0 
      ? (statusCounts.completed / statusCounts.total) * 100 
      : 0

    return NextResponse.json({
      totalOrders: statusCounts.total,
      completed: statusCounts.completed,
      processing: statusCounts.processing,
      failed: statusCounts.failed,
      pending: statusCounts.pending,
      successRate,
    })
  } catch (error) {
    console.error("Error fetching orders stats:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
