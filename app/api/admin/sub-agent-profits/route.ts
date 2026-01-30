import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
    try {
        // Verify admin access
        const authHeader = request.headers.get("authorization")
        if (!authHeader?.startsWith("Bearer ")) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const token = authHeader.slice(7)
        const { data: { user }, error: authError } = await supabase.auth.getUser(token)

        if (authError || !user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        // Check if user is admin
        const { data: userData } = await supabase
            .from("users")
            .select("role")
            .eq("id", user.id)
            .single()

        if (userData?.role !== "admin") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        }

        // Get all parent shops (shops that have sub-agents)
        const { data: parentShops, error: parentShopsError } = await supabase
            .from("user_shops")
            .select(`
        id,
        shop_name,
        shop_slug,
        user_id,
        is_active,
        created_at
      `)
            .in("id",
                supabase
                    .from("user_shops")
                    .select("parent_shop_id")
                    .not("parent_shop_id", "is", null)
            )

        if (parentShopsError) {
            console.error("[ADMIN-SUBAGENT-PROFITS] Error fetching parent shops:", parentShopsError)
            // Fallback: get shops that have sub-agents directly
            const { data: subAgentShops } = await supabase
                .from("user_shops")
                .select("parent_shop_id")
                .not("parent_shop_id", "is", null)

            const parentShopIds = [...new Set(subAgentShops?.map(s => s.parent_shop_id) || [])]

            if (parentShopIds.length === 0) {
                return NextResponse.json({ parentShops: [] })
            }

            const { data: fallbackParentShops, error: fallbackError } = await supabase
                .from("user_shops")
                .select(`
          id,
          shop_name,
          shop_slug,
          user_id,
          is_active,
          created_at
        `)
                .in("id", parentShopIds)

            if (fallbackError) {
                throw fallbackError
            }

            // Continue with fallbackParentShops
            const result = await enrichParentShops(fallbackParentShops || [])
            return NextResponse.json({ parentShops: result })
        }

        const result = await enrichParentShops(parentShops || [])
        return NextResponse.json({ parentShops: result })

    } catch (error) {
        console.error("[ADMIN-SUBAGENT-PROFITS] Error:", error)
        return NextResponse.json(
            { error: "Failed to fetch sub-agent profits" },
            { status: 500 }
        )
    }
}

async function enrichParentShops(parentShops: any[]) {
    const enrichedShops = await Promise.all(
        parentShops.map(async (shop) => {
            // Get owner email
            const { data: owner } = await supabase
                .from("users")
                .select("email")
                .eq("id", shop.user_id)
                .single()

            // Get sub-agents
            const { data: subAgents } = await supabase
                .from("user_shops")
                .select(`
          id,
          shop_name,
          shop_slug,
          user_id,
          is_active,
          created_at
        `)
                .eq("parent_shop_id", shop.id)

            // Get profit records for this parent shop (from sub-agent orders)
            const { data: profits } = await supabase
                .from("shop_profits")
                .select("profit_amount, shop_order_id, created_at")
                .eq("shop_id", shop.id)

            // Get orders that generated these profits (sub-agent orders)
            const { data: subAgentOrders } = await supabase
                .from("shop_orders")
                .select("id, shop_id, parent_profit_amount, total_price, created_at")
                .eq("parent_shop_id", shop.id)
                .eq("payment_status", "completed")

            // Calculate total earned from sub-agents
            const totalEarnedFromSubagents = profits?.reduce(
                (sum, p) => sum + (p.profit_amount || 0), 0
            ) || 0

            // Enrich sub-agents with their individual contribution
            const enrichedSubAgents = await Promise.all(
                (subAgents || []).map(async (sa) => {
                    // Get owner email for sub-agent
                    const { data: saOwner } = await supabase
                        .from("users")
                        .select("email")
                        .eq("id", sa.user_id)
                        .single()

                    // Get orders from this sub-agent that contributed to parent
                    const saOrders = subAgentOrders?.filter(o => o.shop_id === sa.id) || []
                    const totalProfitToParent = saOrders.reduce(
                        (sum, o) => sum + (o.parent_profit_amount || 0), 0
                    )
                    const totalOrderValue = saOrders.reduce(
                        (sum, o) => sum + (o.total_price || 0), 0
                    )

                    return {
                        id: sa.id,
                        shop_name: sa.shop_name,
                        shop_slug: sa.shop_slug,
                        owner_email: saOwner?.email || "Unknown",
                        is_active: sa.is_active,
                        created_at: sa.created_at,
                        total_orders: saOrders.length,
                        total_order_value: totalOrderValue,
                        total_profit_to_parent: totalProfitToParent,
                        last_order_date: saOrders.length > 0
                            ? saOrders.sort((a, b) =>
                                new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
                            )[0].created_at
                            : null
                    }
                })
            )

            return {
                id: shop.id,
                shop_name: shop.shop_name,
                shop_slug: shop.shop_slug,
                owner_email: owner?.email || "Unknown",
                is_active: shop.is_active,
                created_at: shop.created_at,
                total_sub_agents: subAgents?.length || 0,
                total_orders_from_subagents: subAgentOrders?.length || 0,
                total_earned_from_subagents: totalEarnedFromSubagents,
                sub_agents: enrichedSubAgents.sort((a, b) => b.total_profit_to_parent - a.total_profit_to_parent)
            }
        })
    )

    // Sort by total earned descending
    return enrichedShops.sort((a, b) => b.total_earned_from_subagents - a.total_earned_from_subagents)
}
