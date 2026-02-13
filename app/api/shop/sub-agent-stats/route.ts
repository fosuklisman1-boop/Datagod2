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

    // Use RPC for fast, accurate statistics calculation
    console.log("[SUB-AGENT-STATS] Calling RPC for earnings stats...")
    const { data: rpcData, error: rpcError } = await supabase.rpc("get_sub_agent_earnings_stats", {
      p_parent_shop_id: shop.id
    })

    if (rpcError) {
      console.error("[SUB-AGENT-STATS] RPC Error:", rpcError)
      throw rpcError
    }

    const { totalEarnings, totalOrders: totalOrdersGlobal, breakdown } = rpcData

    // Create a lookup map from the breakdown
    const breakdownMap = new Map<string, any>()
    breakdown?.forEach((item: any) => {
      breakdownMap.set(item.shop_id, item)
    })

    // Build sub-agent response by matching shops with their stats
    const subAgentsWithStats = subAgentShops.map((sa: any) => {
      const stats = breakdownMap.get(sa.id) || {}
      return {
        id: sa.id,
        shop_name: sa.shop_name,
        shop_slug: sa.shop_slug,
        is_active: sa.is_active,
        created_at: sa.created_at,
        tier_level: sa.tier_level,
        total_orders: stats.total_orders || 0,
        total_sales: stats.total_sales || 0,
        your_earnings: stats.your_earnings || 0,
      }
    })

    // Prepare global stats
    const stats = {
      totalSubAgents: subAgentsWithStats.length,
      activeSubAgents: subAgentsWithStats.filter((sa: any) => sa.is_active).length,
      totalEarningsFromSubAgents: totalEarnings || 0,
    }

    return NextResponse.json({ subAgents: subAgentsWithStats, stats })
  } catch (error) {
    console.error("[SUB-AGENT-STATS] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
