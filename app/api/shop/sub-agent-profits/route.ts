import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET: the caller's own wholesale-margin history from sub-agent data orders.
// Sourced directly from shop_orders.parent_profit_amount (parent_shop_id =
// caller's shop, payment_status = completed) -- the SAME rows
// get_sub_agent_earnings_stats() already sums for the "Your Earnings from
// Sub-Agents" stat card, so this list stays consistent with that total.
// Deliberately NOT sourced from shop_profits: that table also holds the
// shop's OWN direct-sale profit under the same shop_id, with nothing to
// tell the two apart, so summing it for a parent shop that also sells
// directly would silently over-count (a real bug in the admin "Sub-Agent
// Profits" page's totalEarnedFromSubagents, not repeated here).
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7))
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id")
      .eq("user_id", user.id)
      .single()
    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10))
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)))
    const from = (page - 1) * limit
    const to = from + limit - 1

    const { data: orders, error: ordersError, count } = await supabase
      .from("shop_orders")
      .select("id, shop_id, reference_code, network, volume_gb, total_price, parent_profit_amount, created_at", { count: "exact" })
      .eq("parent_shop_id", shop.id)
      .eq("payment_status", "completed")
      .gt("parent_profit_amount", 0)
      .order("created_at", { ascending: false })
      .range(from, to)

    if (ordersError) {
      console.error("[SUB-AGENT-PROFITS] Error fetching orders:", ordersError.message)
      return NextResponse.json({ error: "Failed to fetch profit history" }, { status: 500 })
    }

    const subAgentIds = [...new Set((orders || []).map((o) => o.shop_id).filter(Boolean))]
    const namesById = new Map<string, string>()
    if (subAgentIds.length > 0) {
      const { data: subAgentShops } = await supabase
        .from("user_shops")
        .select("id, shop_name")
        .in("id", subAgentIds)
      subAgentShops?.forEach((s) => namesById.set(s.id, s.shop_name))
    }

    const records = (orders || []).map((o) => ({
      id: o.id,
      sub_agent_shop_name: namesById.get(o.shop_id) || "Unknown",
      reference_code: o.reference_code,
      network: o.network,
      volume_gb: o.volume_gb,
      total_price: Number(o.total_price) || 0,
      profit_amount: Number(o.parent_profit_amount) || 0,
      created_at: o.created_at,
    }))

    const totalCount = count || 0
    const totalPages = Math.max(1, Math.ceil(totalCount / limit))

    return NextResponse.json({ records, pagination: { page, totalPages, totalCount } })
  } catch (error) {
    console.error("[SUB-AGENT-PROFITS] GET error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
