import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Fallback: fetch and aggregate user stats without the RPC
async function getUserStatsFallback(adminClient: any, userId: string) {
  // Fetch basic wallet + shop data
  const [walletResult, shopResult] = await Promise.all([
    adminClient.from("wallets").select("balance").eq("user_id", userId).single(),
    adminClient.from("user_shops").select("id, shop_name, shop_slug, created_at").eq("user_id", userId).single()
  ])

  // Transaction aggregation — limited to 5000 rows to avoid timeout
  const { data: transactions } = await adminClient
    .from("transactions")
    .select("type, source, status, amount")
    .eq("user_id", userId)
    .limit(5000)

  const txList = transactions || []
  const totalTopUps = txList
    .filter((t: any) => t.type === "credit" && t.source === "wallet_topup" && t.status === "completed")
    .reduce((s: number, t: any) => s + (t.amount || 0), 0)
  const totalSpent = txList
    .filter((t: any) => t.type === "debit" && (t.status === "completed" || t.status === "success"))
    .reduce((s: number, t: any) => s + Math.abs(t.amount || 0), 0)

  // Order counts
  const { count: totalOrders } = await adminClient
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
  const { count: completedOrders } = await adminClient
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["completed", "delivered", "success"])
  const { count: failedOrders } = await adminClient
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "failed")

  const total = totalOrders || 0
  const completed = completedOrders || 0
  const failed = failedOrders || 0

  // Shop stats
  let shopStats = null
  let withdrawals = { history: [], totalWithdrawn: 0, pendingCount: 0, completedCount: 0 }

  if (shopResult.data?.id) {
    const shopId = shopResult.data.id

    const [balanceResult, shopOrderCounts, withdrawalRows] = await Promise.all([
      adminClient.from("shop_available_balance").select("*").eq("shop_id", shopId).maybeSingle(),
      adminClient.from("shop_orders").select("id", { count: "exact", head: true }).eq("shop_id", shopId),
      adminClient.from("withdrawal_requests")
        .select("id, amount, fee_amount, net_amount, status, withdrawal_method, created_at, reference_code")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(10)
    ])

    const bal = balanceResult.data
    shopStats = {
      shopId,
      shopName:  shopResult.data.shop_name,
      shopSlug:  shopResult.data.shop_slug,
      createdAt: shopResult.data.created_at,
      totalOrders:      shopOrderCounts.count || 0,
      availableBalance: bal?.available_balance || 0,
      withdrawnAmount:  bal?.withdrawn_profit || 0,
      totalProfit:      bal?.total_profit || 0,
      pendingProfit:    bal?.pending_profit || 0,
      creditedProfit:   bal?.credited_profit || 0,
    }

    const wRows = withdrawalRows.data || []
    const totalWithdrawn = wRows
      .filter((w: any) => w.status === "completed" || w.status === "approved")
      .reduce((s: number, w: any) => s + (w.net_amount || w.amount || 0), 0)

    withdrawals = {
      history: wRows.map((w: any) => ({
        id: w.id, amount: w.amount, feeAmount: w.fee_amount || 0,
        netAmount: w.net_amount || w.amount, status: w.status,
        method: w.withdrawal_method, createdAt: w.created_at, referenceCode: w.reference_code
      })),
      totalWithdrawn,
      pendingCount: wRows.filter((w: any) => w.status === "pending").length,
      completedCount: wRows.filter((w: any) => w.status === "completed" || w.status === "approved").length,
    }
  }

  return {
    wallet: {
      balance: walletResult.data?.balance || 0,
      totalTopUps,
      totalSpent,
      transactionCount: txList.length,
    },
    orders: { total, completed, failed, pending: total - completed - failed },
    shop: shopStats,
    withdrawals,
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  try {
    const { id: userId } = await params

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // Try the optimized RPC first; if not deployed yet, fall back to direct queries
    const { data: stats, error: rpcError } = await adminClient.rpc("get_user_financial_summary", {
      p_user_id: userId
    })

    if (rpcError) {
      console.warn("[USER-STATS] RPC not available, using fallback queries:", rpcError.message)
      const fallback = await getUserStatsFallback(adminClient, userId)
      return NextResponse.json({ userId, ...fallback })
    }

    if (!stats) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    return NextResponse.json({
      userId,
      wallet: stats.wallet,
      orders: stats.orders,
      shop: stats.shop,
      withdrawals: stats.withdrawals,
    })
  } catch (error: any) {
    console.error("[USER-STATS] Unexpected error:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
