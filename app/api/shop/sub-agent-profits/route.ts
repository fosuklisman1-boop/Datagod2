import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET: the caller's own wholesale-margin history from sub-agent data orders.
// Sourced from parent_profit_amount on BOTH shop_orders (web storefront) and
// ussd_shop_orders (USSD shop code / WhatsApp bot) via
// get_sub_agent_profit_history() (migration 0162) -- the SAME tables
// get_sub_agent_earnings_stats() sums for the "Your Earnings from
// Sub-Agents" stat card, so this list stays consistent with that total.
// (Before 0162 both read shop_orders only, hiding every USSD/WhatsApp sale.)
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
    const { data: history, error: ordersError } = await supabase.rpc("get_sub_agent_profit_history", {
      p_parent_shop_id: shop.id,
      p_limit: limit,
      p_offset: (page - 1) * limit,
    })

    if (ordersError) {
      console.error("[SUB-AGENT-PROFITS] Error fetching orders:", ordersError.message)
      return NextResponse.json({ error: "Failed to fetch profit history" }, { status: 500 })
    }

    type HistoryRow = {
      id: string
      shop_id: string
      reference_code: string | null
      network: string | null
      volume_gb: number | string | null
      total_price: number | string | null
      profit_amount: number | string | null
      created_at: string
    }
    const orders: HistoryRow[] = Array.isArray(history?.records) ? history.records : []
    const count = Number(history?.total) || 0

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
      volume_gb: o.volume_gb ?? "",
      total_price: Number(o.total_price) || 0,
      profit_amount: Number(o.profit_amount) || 0,
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
