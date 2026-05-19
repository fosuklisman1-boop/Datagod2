import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { searchParams } = new URL(request.url)

    // Pagination
    const page = parseInt(searchParams.get("page") || "1")
    const limit = parseInt(searchParams.get("limit") || "50")
    const offset = (page - 1) * limit

    // Filters
    const search = searchParams.get("search") || ""
    const status = searchParams.get("status") || "" // pending, credited, withdrawn
    const startDate = searchParams.get("startDate") || ""
    const endDate = searchParams.get("endDate") || ""
    const shopId = searchParams.get("shopId") || ""

    console.log("[ADMIN-PROFITS] Fetching profits history with filters:", { page, limit, search, status, startDate, endDate, shopId })

    // Build query for profit records with shop and order details
    // Note: user_shops.user_id references auth.users, so we fetch user details separately
    let query = supabase
      .from("shop_profits")
      .select(`
        id,
        shop_id,
        shop_order_id,
        ussd_order_id,
        ussd_shop_order_id,
        profit_amount,
        profit_balance_before,
        profit_balance_after,
        status,
        credited_at,
        created_at,
        user_shops (
          id,
          shop_name,
          shop_slug,
          user_id,
          parent_shop_id
        ),
        shop_orders (
          id,
          reference_code,
          network,
          volume_gb,
          total_price,
          customer_name,
          customer_phone,
          shop_id,
          parent_shop_id,
          parent_profit_amount,
          profit_amount
        ),
        ussd_orders (
          id,
          network,
          package_size,
          amount,
          dialing_phone,
          paystack_reference
        )
      `, { count: "exact" })
      .order("created_at", { ascending: false })

    // Apply filters
    if (shopId) {
      query = query.eq("shop_id", shopId)
    }

    if (status) {
      query = query.eq("status", status)
    }

    if (startDate) {
      query = query.gte("created_at", startDate)
    }

    if (endDate) {
      // Add 1 day to include the end date fully
      const endDateObj = new Date(endDate)
      endDateObj.setDate(endDateObj.getDate() + 1)
      query = query.lt("created_at", endDateObj.toISOString())
    }

    // If searching, we need to fetch all records first, then filter and paginate in memory
    // Otherwise, apply pagination at the database level
    let allProfitsForSearch: any[] = []
    let profits: any[] = []
    let error: any = null
    let count: number | null = null

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

    if (search) {
      // Fetch all records recursively for search
      profits = await fetchAll(
        supabase
          .from("shop_profits")
          .select(`
            id,
            shop_id,
            shop_order_id,
            ussd_order_id,
            ussd_shop_order_id,
            profit_amount,
            profit_balance_before,
            profit_balance_after,
            status,
            credited_at,
            created_at,
            user_shops (
              id,
              shop_name,
              shop_slug,
              user_id,
              parent_shop_id
            ),
            shop_orders (
              id,
              reference_code,
              network,
              volume_gb,
              total_price,
              customer_name,
              customer_phone,
              shop_id,
              parent_shop_id,
              parent_profit_amount,
              profit_amount
            ),
            ussd_orders (
              id,
              network,
              package_size,
              amount,
              dialing_phone,
              paystack_reference
            )
          `)
          .order("created_at", { ascending: false })
      )
    } else {
      // Apply pagination at database level when not searching
      query = query.range(offset, offset + limit - 1)
      const result = await query
      profits = result.data || []
      error = result.error
      count = result.count
    }

    if (error) {
      console.error("[ADMIN-PROFITS] Error fetching profits:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      )
    }

    // Batch-fetch ussd_shop_orders (no FK so PostgREST can't join automatically)
    const ussdShopOrderIds = [...new Set((profits || []).map((p: any) => p.ussd_shop_order_id).filter(Boolean))]
    let ussdShopOrdersMap: Record<string, any> = {}
    if (ussdShopOrderIds.length > 0) {
      const { data: ussdShopRows } = await supabase
        .from("ussd_shop_orders")
        .select("id, network, package_size, amount, paystack_reference, profit_amount, shop_name, customer_email, recipient_phone, dialing_phone")
        .in("id", ussdShopOrderIds)
      ussdShopRows?.forEach((r: any) => { ussdShopOrdersMap[r.id] = r })
    }

    // Fetch user details separately (since user_shops.user_id references auth.users)
    const userIds = [...new Set((profits || []).map((p: any) => p.user_shops?.user_id).filter(Boolean))]

    let usersMap: Record<string, any> = {}
    if (userIds.length > 0) {
      const { data: usersData } = await supabase
        .from("users")
        .select("id, email, first_name, last_name, phone_number")
        .in("id", userIds)

      usersData?.forEach((u: any) => {
        usersMap[u.id] = u
      })
    }

    // Filter by search if provided (post-query for complex joins)
    let filteredProfits = profits || []
    if (search) {
      const searchLower = search.toLowerCase()
      filteredProfits = filteredProfits.filter((p: any) => {
        const shopName = p.user_shops?.shop_name?.toLowerCase() || ""
        const user = usersMap[p.user_shops?.user_id] || {}
        const ownerEmail = user.email?.toLowerCase() || ""
        const ownerName = `${user.first_name || ""} ${user.last_name || ""}`.toLowerCase()
        const orderRef = (
          p.shop_orders?.reference_code ||
          ussdShopOrdersMap[p.ussd_shop_order_id]?.paystack_reference ||
          p.ussd_order_id ||
          ""
        ).toLowerCase()

        return shopName.includes(searchLower) ||
          ownerEmail.includes(searchLower) ||
          ownerName.includes(searchLower) ||
          orderRef.includes(searchLower)
      })
    }

    // Apply pagination to filtered results when searching
    const totalFilteredCount = filteredProfits.length
    if (search) {
      filteredProfits = filteredProfits.slice(offset, offset + limit)
    }

    // Flatten data for frontend
    const flattenedProfits = filteredProfits.map((p: any) => {
      const user = usersMap[p.user_shops?.user_id] || {}

      // Resolve the source order — whichever FK is non-null wins
      const shopOrder = p.shop_orders ?? null
      const ussdOrder = p.ussd_orders ?? null
      const ussdShopOrder = ussdShopOrdersMap[p.ussd_shop_order_id] ?? null

      // Unified order fields — coalesce across all three sources
      const orderReference =
        shopOrder?.reference_code ??
        ussdShopOrder?.paystack_reference ??
        ussdOrder?.paystack_reference ??
        null
      const orderNetwork = shopOrder?.network ?? ussdShopOrder?.network ?? ussdOrder?.network ?? null
      const orderVolumeGb = shopOrder?.volume_gb ?? ussdShopOrder?.package_size ?? ussdOrder?.package_size ?? null
      const orderTotalPrice = shopOrder?.total_price ?? ussdShopOrder?.amount ?? ussdOrder?.amount ?? null
      const customerName = shopOrder?.customer_name ?? null
      const customerPhone = shopOrder?.customer_phone ?? ussdShopOrder?.dialing_phone ?? ussdOrder?.dialing_phone ?? null

      // Profit breakdown
      const orderParentShopId = shopOrder?.parent_shop_id ?? null
      const isParentProfit = orderParentShopId && p.shop_id === orderParentShopId
      const subAgentProfit = shopOrder?.profit_amount ?? ussdShopOrder?.profit_amount ?? 0
      const parentProfit = shopOrder?.parent_profit_amount ?? 0

      return {
        id: p.id,
        shop_id: p.shop_id,
        shop_order_id: p.shop_order_id,
        ussd_order_id: p.ussd_order_id ?? null,
        ussd_shop_order_id: p.ussd_shop_order_id ?? null,
        profit_amount: p.profit_amount ?? 0,
        profit_balance_before: p.profit_balance_before ?? null,
        profit_balance_after: p.profit_balance_after ?? null,
        status: p.status,
        credited_at: p.credited_at,
        created_at: p.created_at,
        shop_name: p.user_shops?.shop_name || "Unknown Shop",
        shop_slug: p.user_shops?.shop_slug || "",
        owner_email: user.email || "Unknown",
        owner_first_name: user.first_name || null,
        owner_last_name: user.last_name || null,
        owner_phone: user.phone_number || null,
        order_reference: orderReference,
        order_network: orderNetwork,
        order_volume_gb: orderVolumeGb,
        order_total_price: orderTotalPrice,
        customer_name: customerName,
        customer_phone: customerPhone,
        // Sub-agent/parent profit visibility
        is_parent_profit: isParentProfit,
        is_subagent_order: !!orderParentShopId,
        sub_agent_profit: subAgentProfit,
        parent_profit: parentProfit,
      }
    })

    // Calculate stats using RPC for performance and accuracy
    const { data: stats, error: statsError } = await supabase.rpc("get_profits_history_stats", {
      p_shop_id: shopId || null,
      p_status: status || "",
      p_start_date: startDate || null,
      p_end_date: endDate || null
    })

    if (statsError) {
      console.error("[ADMIN-PROFITS] Stats RPC error:", statsError)
      throw statsError
    }
    const totalCount = search ? totalFilteredCount : (count || 0)

    console.log("[ADMIN-PROFITS] Returning", flattenedProfits.length, "profits, total:", totalCount)

    return NextResponse.json({
      profits: flattenedProfits,
      stats: stats,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    })
  } catch (error) {
    console.error("[ADMIN-PROFITS] Unexpected error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
