import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "public, s-maxage=0, stale-while-revalidate=0"
}

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: corsHeaders }
      )
    }

    const token = authHeader.slice(7)
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    )

    // Verify user is admin
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)

    if (userError || !user) {
      return NextResponse.json(
        { error: "Invalid token" },
        { status: 401, headers: corsHeaders }
      )
    }

    // Check if user is admin (check metadata first, then users table)
    let isAdmin = user.user_metadata?.role === "admin"
    if (!isAdmin) {
      const { data: userData } = await supabase
        .from("users")
        .select("role")
        .eq("id", user.id)
        .single()
      isAdmin = userData?.role === "admin"
    }

    if (!isAdmin) {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403, headers: corsHeaders }
      )
    }

    // Get total users count
    const { count: totalUsers, error: usersError } = await supabase
      .from("users")
      .select("id", { count: "exact", head: true })

    // Get total shops count
    const { count: totalShops, error: shopsError } = await supabase
      .from("user_shops")
      .select("id", { count: "exact", head: true })

    // Get all orders with pricing info
    const { data: orders, error: ordersError } = await supabase
      .from("shop_orders")
      .select("id, total_price, order_status")

    // Calculate totals
    const totalOrders = orders?.length || 0
    const totalRevenue = orders?.reduce((sum: number, order: any) => {
      return sum + (order.total_price || 0)
    }, 0) || 0

    // Get pending shops
    const { count: pendingShops, error: pendingError } = await supabase
      .from("user_shops")
      .select("id", { count: "exact", head: true })
      .eq("is_active", false)

    // Get completed orders
    const completedOrders = orders?.filter((o: any) => o.order_status === "completed") || []

    return NextResponse.json(
      {
        totalUsers: totalUsers || 0,
        totalShops: totalShops || 0,
        totalOrders: totalOrders,
        totalRevenue: totalRevenue,
        pendingShops: pendingShops || 0,
        completedOrders: completedOrders.length,
        successRate: totalOrders ? ((completedOrders.length / totalOrders) * 100).toFixed(2) : 0,
      },
      { status: 200, headers: corsHeaders }
    )
  } catch (error) {
    console.error("[ADMIN-STATS] Unexpected error:", error)
    return NextResponse.json(
      { error: "Failed to fetch dashboard stats" },
      { status: 500, headers: corsHeaders }
    )
  }
}

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders })
}
