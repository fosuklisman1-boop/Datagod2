import { supabase } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    // Get pending orders from both tables with payment verified
    // 1. Bulk user orders (orders table with status='pending')
    // Note: All pending bulk orders are already paid (wallet was deducted at creation)
    const { data: userOrders, error: userOrdersError } = await supabase
      .from("orders")
      .select("id")
      .eq("status", "pending")

    if (userOrdersError) throw userOrdersError

    // 2. Shop orders (shop_orders table with order_status='pending' AND payment_status='completed')
    const { data: shopOrders, error: shopOrdersError } = await supabase
      .from("shop_orders")
      .select("id")
      .eq("order_status", "pending")
      .eq("payment_status", "completed")

    if (shopOrdersError) throw shopOrdersError

    // 3. API orders (api_orders table with status='pending')
    const { data: apiOrders, error: apiOrdersError } = await supabase
      .from("api_orders")
      .select("id")
      .eq("status", "pending")

    if (apiOrdersError) throw apiOrdersError

    // Total pending orders = user orders + shop orders + api orders
    const totalPendingCount = (userOrders?.length || 0) + (shopOrders?.length || 0) + (apiOrders?.length || 0)

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
