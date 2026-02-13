import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Use service role to bypass RLS for cross-shop queries
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  try {
    // Get user from auth header
    const authHeader = request.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.replace("Bearer ", "")

    // Verify token and get user
    const userSupabase = createClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
    const { data: { user }, error: authError } = await userSupabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 })
    }

    // Get user's shop
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id")
      .eq("user_id", user.id)
      .single()

    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // Get sub-agents (shops with this shop as parent)
    const { data: subAgentShops, error: subAgentError } = await supabase
      .from("user_shops")
      .select("id, shop_name, shop_slug, is_active, created_at, tier_level")
      .eq("parent_shop_id", shop.id)
      .order("created_at", { ascending: false })

    if (subAgentError) {
      console.error("[SUB-AGENT-STATS] Error fetching sub-agents:", subAgentError)
      return NextResponse.json({ error: "Failed to fetch sub-agents" }, { status: 500 })
    }

    if (!subAgentShops || subAgentShops.length === 0) {
      return NextResponse.json({
        subAgents: [],
        stats: { totalSubAgents: 0, activeSubAgents: 0, totalEarningsFromSubAgents: 0 }
      })
    }

    const subAgentShopIds = subAgentShops.map(sa => sa.id)

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

    // Get ALL orders related to sub-agents:
    // 1. Orders where parent_shop_id = this shop (buy-stock or storefront with parent chain)
    // 2. Orders where shop_id is a sub-agent shop (storefront orders)
    // Then dedupe by order ID to avoid double-counting

    console.log("[SUB-AGENT-STATS] Fetching related orders...")

    // Fetch parent chain orders recursively
    const parentChainOrders = await fetchAll(
      supabase
        .from("shop_orders")
        .select("id, shop_id, total_price, parent_profit_amount")
        .eq("parent_shop_id", shop.id)
        .eq("payment_status", "completed")
    )

    // Fetch sub-agent shop orders recursively
    const subAgentShopOrders = await fetchAll(
      supabase
        .from("shop_orders")
        .select("id, shop_id, total_price, parent_profit_amount")
        .in("shop_id", subAgentShopIds)
        .eq("payment_status", "completed")
    )

    // Combine and dedupe by order ID
    const allOrdersMap = new Map<string, any>()

    parentChainOrders?.forEach((order: any) => {
      allOrdersMap.set(order.id, order)
    })

    subAgentShopOrders?.forEach((order: any) => {
      allOrdersMap.set(order.id, order)
    })

    const uniqueOrders = Array.from(allOrdersMap.values())
    console.log("[SUB-AGENT-STATS] Unique orders after dedup:", uniqueOrders.length)

    // Create maps for each sub-agent's stats
    const subAgentOrdersMap = new Map<string, number>()
    const subAgentSalesMap = new Map<string, number>()
    const subAgentProfitMap = new Map<string, number>()

    // Process unique orders - key by shop_id which is the sub-agent's shop
    uniqueOrders.forEach((order: any) => {
      const shopId = order.shop_id
      // Only count if shop_id is one of our sub-agents
      if (subAgentShopIds.includes(shopId)) {
        subAgentOrdersMap.set(shopId, (subAgentOrdersMap.get(shopId) || 0) + 1)
        subAgentSalesMap.set(shopId, (subAgentSalesMap.get(shopId) || 0) + (order.total_price || 0))
        subAgentProfitMap.set(shopId, (subAgentProfitMap.get(shopId) || 0) + (order.parent_profit_amount || 0))
      }
    })

    console.log("[SUB-AGENT-STATS] Orders map:", Object.fromEntries(subAgentOrdersMap))
    console.log("[SUB-AGENT-STATS] Sales map:", Object.fromEntries(subAgentSalesMap))
    console.log("[SUB-AGENT-STATS] Profit map:", Object.fromEntries(subAgentProfitMap))

    // Build sub-agent response with stats
    const subAgentsWithStats = subAgentShops.map((sa: any) => ({
      id: sa.id,
      shop_name: sa.shop_name,
      shop_slug: sa.shop_slug,
      is_active: sa.is_active,
      created_at: sa.created_at,
      tier_level: sa.tier_level,
      total_orders: subAgentOrdersMap.get(sa.id) || 0,
      total_sales: subAgentSalesMap.get(sa.id) || 0,
      your_earnings: subAgentProfitMap.get(sa.id) || 0,
    }))

    // Calculate totals
    const stats = {
      totalSubAgents: subAgentsWithStats.length,
      activeSubAgents: subAgentsWithStats.filter((sa: any) => sa.is_active).length,
      totalEarningsFromSubAgents: subAgentsWithStats.reduce((sum: number, sa: any) => sum + sa.your_earnings, 0),
    }

    return NextResponse.json({ subAgents: subAgentsWithStats, stats })
  } catch (error) {
    console.error("[SUB-AGENT-STATS] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
