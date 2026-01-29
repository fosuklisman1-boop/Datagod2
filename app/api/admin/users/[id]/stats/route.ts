import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Helper to fetch all records with pagination
async function fetchAllRecords(
  client: any,
  table: string,
  columns: string,
  filterColumn: string,
  filterValue: string
) {
  let allRecords: any[] = []
  let offset = 0
  const batchSize = 1000
  let hasMore = true

  while (hasMore) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .eq(filterColumn, filterValue)
      .range(offset, offset + batchSize - 1)

    if (error) break

    if (data && data.length > 0) {
      allRecords = allRecords.concat(data)
      offset += batchSize
      hasMore = data.length === batchSize
    } else {
      hasMore = false
    }
  }

  return allRecords
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: userId } = await params

    // Verify admin access
    const authHeader = req.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabaseClient = createClient(supabaseUrl, serviceRoleKey)
    const { data: { user: callerUser }, error: callerError } = await supabaseClient.auth.getUser(token)

    if (callerError || !callerUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Check if caller is admin
    let isAdmin = callerUser.user_metadata?.role === "admin"
    if (!isAdmin) {
      const { data: userData } = await supabaseClient
        .from("users")
        .select("role")
        .eq("id", callerUser.id)
        .single()
      isAdmin = userData?.role === "admin"
    }

    if (!isAdmin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // Fetch basic user data and shop info first
    const [walletResult, shopResult] = await Promise.all([
      adminClient.from("wallets").select("balance").eq("user_id", userId).single(),
      adminClient.from("user_shops").select("id, shop_name, shop_slug, created_at").eq("user_id", userId).single()
    ])

    // Fetch all paginated data in parallel
    const [transactions, walletOrders, shopOrdersByUser] = await Promise.all([
      fetchAllRecords(adminClient, "transactions", "*", "user_id", userId),
      fetchAllRecords(adminClient, "orders", "id, status, amount, created_at", "user_id", userId),
      fetchAllRecords(adminClient, "shop_orders", "id, status, total_amount, created_at", "user_id", userId)
    ])

    // Calculate wallet stats
    const walletBalance = walletResult.data?.balance || 0
    
    // Total top-ups: credit transactions from wallet_topup source
    const totalTopUps = transactions
      .filter((t: any) => t.type === "credit" && t.source === "wallet_topup" && t.status === "completed")
      .reduce((sum: number, t: any) => sum + (t.amount || 0), 0)
    
    const totalSpent = transactions
      .filter((t: any) => t.type === "debit" && t.status === "completed")
      .reduce((sum: number, t: any) => sum + Math.abs(t.amount || 0), 0)

    // Calculate order stats (combine wallet orders and shop orders by user)
    const totalOrders = walletOrders.length + shopOrdersByUser.length
    const completedOrders = walletOrders.filter((o: any) => o.status === "completed" || o.status === "delivered").length +
      shopOrdersByUser.filter((o: any) => o.status === "completed" || o.status === "delivered").length
    const failedOrders = walletOrders.filter((o: any) => o.status === "failed").length +
      shopOrdersByUser.filter((o: any) => o.status === "failed").length
    const pendingOrders = totalOrders - completedOrders - failedOrders

    // Shop stats (if user owns a shop)
    let shopStats = null
    let withdrawalHistory: any[] = []

    if (shopResult.data?.id) {
      const shopId = shopResult.data.id

      // Fetch shop-related data with pagination
      const [shopBalanceResult, shopOrdersList, shopProfitsList, withdrawalsList] = await Promise.all([
        adminClient.from("shop_available_balance").select("*").eq("shop_id", shopId).single(),
        fetchAllRecords(adminClient, "shop_orders", "id, total_amount, profit_amount, status, order_status, payment_status, created_at", "shop_id", shopId),
        fetchAllRecords(adminClient, "shop_profits", "id, profit_amount, status, created_at", "shop_id", shopId),
        fetchAllRecords(adminClient, "withdrawal_requests", "*", "shop_id", shopId)
      ])

      const shopOrdersData = shopOrdersList || []
      const shopProfitsData = shopProfitsList || []
      
      // Paid orders are those with payment_status = "completed" 
      const paidShopOrders = shopOrdersData.filter((o: any) => o.payment_status === "completed")
      // Delivered/completed orders for order fulfillment tracking
      const completedShopOrders = shopOrdersData.filter((o: any) => 
        o.order_status === "completed" || o.order_status === "delivered" || 
        o.status === "completed" || o.status === "delivered"
      )
      
      // Calculate total sales from PAID orders (not just delivered ones)
      const totalSales = paidShopOrders.reduce((sum: number, o: any) => sum + (o.total_amount || 0), 0)
      
      // Calculate total profit from shop_profits table (more accurate)
      const totalProfitFromProfits = shopProfitsData.reduce((sum: number, p: any) => sum + (p.profit_amount || 0), 0)

      const balanceRecord = shopBalanceResult.data
      // Use the pre-calculated values from shop_available_balance table
      const availableBalance = balanceRecord?.available_balance || 0
      const withdrawnAmount = balanceRecord?.withdrawn_profit || 0
      const pendingProfit = balanceRecord?.pending_profit || 0
      const totalProfitFromBalance = balanceRecord?.total_profit || 0
      const creditedProfit = balanceRecord?.credited_profit || 0
      
      // Use the higher of the two totals (in case shop_profits has more records)
      const totalProfit = Math.max(totalProfitFromProfits, totalProfitFromBalance)

      shopStats = {
        shopId: shopId,
        shopName: shopResult.data.shop_name,
        shopSlug: shopResult.data.shop_slug,
        createdAt: shopResult.data.created_at,
        totalOrders: shopOrdersData.length,
        paidOrders: paidShopOrders.length,
        completedOrders: completedShopOrders.length,
        totalSales,
        totalProfit,
        availableBalance,
        withdrawnAmount,
        pendingProfit,
        creditedProfit,
        profitRecords: shopProfitsData.length
      }

      // Withdrawal history - sort by created_at descending
      const sortedWithdrawals = withdrawalsList.sort((a: any, b: any) => 
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
      
      withdrawalHistory = sortedWithdrawals.map((w: any) => ({
        id: w.id,
        amount: w.amount,
        feeAmount: w.fee_amount || 0,
        netAmount: w.net_amount || w.amount,
        status: w.status,
        method: w.withdrawal_method,
        createdAt: w.created_at,
        referenceCode: w.reference_code
      }))
    }

    // Calculate withdrawal totals
    const totalWithdrawn = withdrawalHistory
      .filter((w: any) => w.status === "completed" || w.status === "approved")
      .reduce((sum: number, w: any) => sum + (w.netAmount || w.amount || 0), 0)
    
    const pendingWithdrawals = withdrawalHistory.filter((w: any) => w.status === "pending").length

    return NextResponse.json({
      userId,
      wallet: {
        balance: walletBalance,
        totalTopUps,
        totalSpent,
        transactionCount: transactions.length
      },
      orders: {
        total: totalOrders,
        completed: completedOrders,
        failed: failedOrders,
        pending: pendingOrders
      },
      shop: shopStats,
      withdrawals: {
        history: withdrawalHistory,
        totalWithdrawn,
        pendingCount: pendingWithdrawals,
        completedCount: withdrawalHistory.filter((w: any) => w.status === "completed" || w.status === "approved").length
      }
    })
  } catch (error: any) {
    console.error("[USER-STATS] Error:", error)
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 })
  }
}
