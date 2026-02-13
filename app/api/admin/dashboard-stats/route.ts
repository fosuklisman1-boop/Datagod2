import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export async function GET(request: NextRequest) {
  try {
    // Verify admin access (checks both user_metadata and users table)
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    )

    // Helper function to fetch ALL records in batches
    async function fetchAll(queryBuilder: any) {
      let results: any[] = []
      let from = 0
      const step = 1000
      while (true) {
        const { data, error } = await queryBuilder.range(from, from + step - 1)
        if (error) throw error
        if (!data || data.length === 0) break
        results = [...results, ...data]
        if (data.length < step) break
        from += step
      }
      return results
    }

    // Get total users count
    const { count: totalUsers, error: usersError } = await supabase
      .from("users")
      .select("id", { count: "exact", head: true })

    // Get all wallet balances using recursive fetch
    const wallets = await fetchAll(supabase.from("wallets").select("user_id, balance"))

    // Get all shop available balances using recursive fetch
    const shopBalances = await fetchAll(supabase.from("shop_available_balance").select("shop_id, available_balance"))

    // Calculate total wallet balance
    let totalWalletBalance = 0
    if (wallets && wallets.length > 0) {
      totalWalletBalance = wallets.reduce(
        (sum, wallet) => sum + (wallet.balance || 0),
        0
      )
    }

    // Get all shops to calculate profit balance per user using recursive fetch
    const shops = await fetchAll(supabase.from("user_shops").select("id, user_id"))

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

    // Get total orders count
    const { count: totalOrdersCount, error: totalOrdersError } = await supabase
      .from("shop_orders")
      .select("id", { count: "exact", head: true })

    // Get total revenue by paginating through ALL orders
    let allOrders: any[] = []
    let ordersOffset = 0
    const ordersBatchSize = 1000
    let hasMoreOrders = true

    while (hasMoreOrders) {
      const { data, error } = await supabase
        .from("shop_orders")
        .select("total_price")
        .range(ordersOffset, ordersOffset + ordersBatchSize - 1)

      if (error) {
        console.error("[ADMIN-STATS] Error fetching orders batch:", error)
        break
      }

      if (data && data.length > 0) {
        allOrders = allOrders.concat(data)
        ordersOffset += ordersBatchSize
        hasMoreOrders = data.length === ordersBatchSize
      } else {
        hasMoreOrders = false
      }
    }

    // Calculate totals from ALL fetched orders
    const totalOrders = totalOrdersCount || 0
    const totalRevenue = allOrders.reduce((sum: number, order: any) => {
      return sum + (order.total_price || 0)
    }, 0)

    // Get pending shops count using efficient exact count query
    const { count: pendingShops, error: pendingError } = await supabase
      .from("user_shops")
      .select("id", { count: "exact", head: true })
      .eq("is_active", false)

    // Get completed orders count with exact count
    const { count: completedOrdersCount, error: completedError } = await supabase
      .from("shop_orders")
      .select("id", { count: "exact", head: true })
      .eq("order_status", "completed")

    return NextResponse.json(
      {
        totalUsers: totalUsers || 0,
        totalShops: totalShops || 0,
        totalSubAgents: totalSubAgents || 0,
        totalOrders: totalOrders,
        totalRevenue: totalRevenue,
        pendingShops: pendingShops || 0,
        completedOrders: completedOrdersCount || 0,
        successRate: totalOrders ? ((((completedOrdersCount || 0) / totalOrders) * 100).toFixed(2)) : 0,
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
