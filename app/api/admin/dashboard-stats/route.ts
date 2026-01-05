import { createClient } from "@supabase/supabase-js"
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
        { status: 401 }
      )
    }

    // Check if user is admin
    const { data: userData, error: roleError } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single()

    if (roleError || userData?.role !== "admin") {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      )
    }

    // Get total users count
    const { count: totalUsers, error: usersError } = await supabase
      .from("users")
      .select("id", { count: "exact", head: true })

    // Get all users with wallet and profit balances
    const { data: usersData, error: usersBalanceError } = await supabase
      .from("users")
      .select("id")

    // Get wallet balances
    const { data: wallets, error: walletsError } = await supabase
      .from("wallets")
      .select("user_id, balance")

    // Get shop available balances (profit balances)
    const { data: shopBalances, error: shopBalancesError } = await supabase
      .from("shop_available_balance")
      .select("shop_id, available_balance")

    // Calculate total wallet balance
    let totalWalletBalance = 0
    if (wallets && wallets.length > 0) {
      totalWalletBalance = wallets.reduce(
        (sum, wallet) => sum + (wallet.balance || 0),
        0
      )
    }

    // Get shop owners to calculate profit balance per user
    const { data: shops, error: shopsDataError } = await supabase
      .from("user_shops")
      .select("id, user_id")

    // Calculate total profit balance (sum of available_balance from shop_available_balance)
    let totalProfitBalance = 0
    if (shopBalances && shopBalances.length > 0) {
      totalProfitBalance = shopBalances.reduce(
        (sum, shopBalance) => sum + (shopBalance.available_balance || 0),
        0
      )
    }

    // Get total shops count
    const { count: totalShops, error: shopsError } = await supabase
      .from("user_shops")
      .select("id", { count: "exact", head: true })

    // Get total sub-agents count (shops with parent_shop_id)
    const { count: totalSubAgents, error: subAgentsError } = await supabase
      .from("user_shops")
      .select("id", { count: "exact", head: true })
      .not("parent_shop_id", "is", null)

    // Get all orders with pricing info
    const { data: orders, error: ordersError } = await supabase
      .from("shop_orders")
      .select("id, total_price, order_status")
      .limit(10000) // Override default 1000 limit to support larger datasets

    // Calculate totals
    const totalOrders = orders?.length || 0
    const totalRevenue = orders?.reduce((sum: number, order: any) => {
      return sum + (order.total_price || 0)
    }, 0) || 0

    // Get pending shops count using efficient exact count query
    const { count: pendingShops, error: pendingError } = await supabase
      .from("user_shops")
      .select("id", { count: "exact", head: true })
      .eq("is_active", false)

    // Get completed orders count
    const completedOrdersCount = orders?.filter((o: any) => o.order_status === "completed").length || 0

    return NextResponse.json(
      {
        totalUsers: totalUsers || 0,
        totalShops: totalShops || 0,
        totalSubAgents: totalSubAgents || 0,
        totalOrders: totalOrders,
        totalRevenue: totalRevenue,
        pendingShops: pendingShops || 0,
        completedOrders: completedOrdersCount,
        successRate: totalOrders ? ((completedOrdersCount / totalOrders) * 100).toFixed(2) : 0,
        totalWalletBalance,
        totalProfitBalance,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("[ADMIN-STATS] Unexpected error:", error)
    return NextResponse.json(
      { error: "Failed to fetch dashboard stats" },
      { status: 500 }
    )
  }
}
