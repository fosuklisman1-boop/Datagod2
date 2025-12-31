import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

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

    // Fetch all stats in parallel
    const [
      walletResult,
      transactionsResult,
      ordersResult,
      shopOrdersResult,
      shopResult,
      shopBalanceResult,
      withdrawalsResult
    ] = await Promise.all([
      // Wallet balance
      adminClient.from("wallets").select("balance").eq("user_id", userId).single(),
      
      // Transactions for top-ups and spending
      adminClient.from("transactions").select("*").eq("user_id", userId),
      
      // Orders placed by user (wallet orders)
      adminClient.from("orders").select("id, status, amount, created_at").eq("user_id", userId),
      
      // Shop orders placed by user
      adminClient.from("shop_orders").select("id, status, total_amount, created_at").eq("user_id", userId),
      
      // User's shop
      adminClient.from("user_shops").select("id, shop_name, shop_slug, created_at").eq("user_id", userId).single(),
      
      // Will be populated if shop exists
      null,
      
      // Will be populated if shop exists
      null
    ])

    // Calculate wallet stats
    const walletBalance = walletResult.data?.balance || 0
    const transactions = transactionsResult.data || []
    
    const totalTopUps = transactions
      .filter((t: any) => t.type === "credit" && t.source === "paystack" && t.status === "completed")
      .reduce((sum: number, t: any) => sum + (t.amount || 0), 0)
    
    const totalSpent = transactions
      .filter((t: any) => t.type === "debit" && t.status === "completed")
      .reduce((sum: number, t: any) => sum + Math.abs(t.amount || 0), 0)

    // Calculate order stats (combine wallet orders and shop orders by user)
    const walletOrders = ordersResult.data || []
    const shopOrdersByUser = shopOrdersResult.data || []
    
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

      // Fetch shop-related data
      const [shopBalanceData, shopOrdersData, shopProfitsData, withdrawalsData] = await Promise.all([
        adminClient.from("shop_available_balance").select("*").eq("shop_id", shopId).single(),
        adminClient.from("shop_orders").select("id, total_amount, profit_amount, status, created_at").eq("shop_id", shopId),
        adminClient.from("shop_profits").select("id, profit_amount, status, created_at").eq("shop_id", shopId),
        adminClient.from("withdrawal_requests").select("*").eq("shop_id", shopId).order("created_at", { ascending: false })
      ])

      const shopOrders = shopOrdersData.data || []
      const shopProfits = shopProfitsData.data || []
      const completedShopOrders = shopOrders.filter((o: any) => o.status === "completed" || o.status === "delivered")
      
      // Calculate total sales from completed orders
      const totalSales = completedShopOrders.reduce((sum: number, o: any) => sum + (o.total_amount || 0), 0)
      
      // Calculate total profit from shop_profits table (more accurate)
      const totalProfitFromProfits = shopProfits.reduce((sum: number, p: any) => sum + (p.profit_amount || 0), 0)

      const balanceRecord = shopBalanceData.data
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
        totalOrders: shopOrders.length,
        completedOrders: completedShopOrders.length,
        totalSales,
        totalProfit,
        availableBalance,
        withdrawnAmount,
        pendingProfit,
        creditedProfit,
        profitRecords: shopProfits.length
      }

      // Withdrawal history
      withdrawalHistory = (withdrawalsData.data || []).map((w: any) => ({
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
