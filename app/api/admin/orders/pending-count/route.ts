import { supabase } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization")
    
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    // Extract token from Bearer header
    const token = authHeader.slice(7)

    // Verify the token and get user
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    
    if (authError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    // Check if user is admin
    const role = user.user_metadata?.role
    if (role !== "admin") {
      return NextResponse.json(
        { error: "Forbidden" },
        { status: 403 }
      )
    }

    // Get pending orders from both tables
    // 1. Regular user orders (orders table with status='pending')
    const { data: userOrders, error: userOrdersError } = await supabase
      .from("orders")
      .select("id")
      .eq("status", "pending")

    if (userOrdersError) throw userOrdersError

    // 2. Shop orders (shop_orders table with order_status='pending')
    const { data: shopOrders, error: shopOrdersError } = await supabase
      .from("shop_orders")
      .select("id")
      .eq("order_status", "pending")

    if (shopOrdersError) throw shopOrdersError

    // Total pending orders = user orders + shop orders
    const totalPendingCount = (userOrders?.length || 0) + (shopOrders?.length || 0)

    return NextResponse.json({
      count: totalPendingCount
    })
  } catch (error) {
    console.error("Error fetching admin pending orders count:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
