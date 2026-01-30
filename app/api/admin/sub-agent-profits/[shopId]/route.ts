import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ shopId: string }> }
) {
    try {
        const { shopId } = await params

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

        // Get the parent shop
        const { data: parentShop, error: shopError } = await supabase
            .from("user_shops")
            .select(`
        id,
        shop_name,
        shop_slug,
        user_id,
        is_active,
        created_at
      `)
            .eq("id", shopId)
            .single()

        if (shopError || !parentShop) {
            return NextResponse.json({ error: "Shop not found" }, { status: 404 })
        }

        // Get owner info
        const { data: owner } = await supabase
            .from("users")
            .select("email, phone")
            .eq("id", parentShop.user_id)
            .single()

        // Get shop available balance
        const { data: balance } = await supabase
            .from("shop_available_balance")
            .select("available_balance, total_profit, credited_profit, withdrawn_amount")
            .eq("shop_id", shopId)
            .single()

        // Get all sub-agents for this parent
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
            .eq("parent_shop_id", shopId)

        // Get all completed orders from sub-agents that contributed to this parent
        const { data: subAgentOrders } = await supabase
            .from("shop_orders")
            .select(`
        id,
        reference_code,
        shop_id,
        customer_phone,
        customer_name,
        network,
        volume_gb,
        total_price,
        parent_profit_amount,
        payment_status,
        order_status,
        created_at
      `)
            .eq("parent_shop_id", shopId)
            .eq("payment_status", "completed")
            .order("created_at", { ascending: false })

        // Get profit records for this parent shop
        const { data: profitRecords } = await supabase
            .from("shop_profits")
            .select(`
        id,
        shop_order_id,
        profit_amount,
        profit_balance_before,
        profit_balance_after,
        status,
        created_at
      `)
            .eq("shop_id", shopId)
            .order("created_at", { ascending: false })

        // Enrich sub-agents with their individual stats
        const enrichedSubAgents = await Promise.all(
            (subAgents || []).map(async (sa) => {
                const { data: saOwner } = await supabase
                    .from("users")
                    .select("email")
                    .eq("id", sa.user_id)
                    .single()

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
                    total_profit_to_parent: totalProfitToParent
                }
            })
        )

        // Create profit history by merging orders with profit records
        const profitHistory = (subAgentOrders || []).map(order => {
            // Find the sub-agent for this order
            const subAgent = subAgents?.find(sa => sa.id === order.shop_id)

            // Find the corresponding profit record
            const profitRecord = profitRecords?.find(p => p.shop_order_id === order.id)

            return {
                id: order.id,
                reference_code: order.reference_code,
                sub_agent_id: order.shop_id,
                sub_agent_name: subAgent?.shop_name || "Unknown",
                customer_phone: order.customer_phone,
                customer_name: order.customer_name,
                network: order.network,
                volume_gb: order.volume_gb,
                order_total: order.total_price,
                profit_amount: order.parent_profit_amount,
                profit_record_id: profitRecord?.id || null,
                profit_status: profitRecord?.status || "missing",
                created_at: order.created_at
            }
        })

        // Calculate summary stats
        const totalEarned = profitHistory.reduce((sum, p) => sum + (p.profit_amount || 0), 0)
        const totalOrderValue = profitHistory.reduce((sum, p) => sum + (p.order_total || 0), 0)

        return NextResponse.json({
            parent_shop: {
                id: parentShop.id,
                shop_name: parentShop.shop_name,
                shop_slug: parentShop.shop_slug,
                owner_email: owner?.email || "Unknown",
                owner_phone: owner?.phone || null,
                is_active: parentShop.is_active,
                created_at: parentShop.created_at,
                available_balance: balance?.available_balance || 0,
                total_profit: balance?.total_profit || 0,
                credited_profit: balance?.credited_profit || 0,
                withdrawn_amount: balance?.withdrawn_amount || 0
            },
            summary: {
                total_sub_agents: subAgents?.length || 0,
                total_orders: subAgentOrders?.length || 0,
                total_order_value: totalOrderValue,
                total_earned_from_subagents: totalEarned,
                profit_records_count: profitRecords?.length || 0
            },
            sub_agents: enrichedSubAgents.sort((a, b) => b.total_profit_to_parent - a.total_profit_to_parent),
            profit_history: profitHistory.slice(0, 100) // Limit to 100 most recent
        })

    } catch (error) {
        console.error("[ADMIN-SUBAGENT-PROFITS-DETAIL] Error:", error)
        return NextResponse.json(
            { error: "Failed to fetch sub-agent profit details" },
            { status: 500 }
        )
    }
}
