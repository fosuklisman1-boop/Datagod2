import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
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
          user_id
        ),
        shop_orders (
          id,
          reference_code,
          network,
          volume_gb,
          total_price,
          customer_name,
          customer_phone
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

    if (search) {
      // Fetch all records in batches for search (to search across all data)
      let searchOffset = 0
      const searchLimit = 1000
      let hasMore = true
      
      while (hasMore) {
        const { data: batchData, error: batchError } = await supabase
          .from("shop_profits")
          .select(`
            id,
            shop_id,
            shop_order_id,
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
              user_id
            ),
            shop_orders (
              id,
              reference_code,
              network,
              volume_gb,
              total_price,
              customer_name,
              customer_phone
            )
          `)
          .order("created_at", { ascending: false })
          .range(searchOffset, searchOffset + searchLimit - 1)
        
        if (batchError) {
          error = batchError
          break
        }
        
        if (batchData && batchData.length > 0) {
          allProfitsForSearch = allProfitsForSearch.concat(batchData)
          searchOffset += searchLimit
          hasMore = batchData.length === searchLimit
        } else {
          hasMore = false
        }
      }
      
      profits = allProfitsForSearch
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
        const orderRef = p.shop_orders?.reference_code?.toLowerCase() || ""
        
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
      return {
        id: p.id,
        shop_id: p.shop_id,
        shop_order_id: p.shop_order_id,
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
        order_reference: p.shop_orders?.reference_code || null,
        order_network: p.shop_orders?.network || null,
        order_volume_gb: p.shop_orders?.volume_gb || null,
        order_total_price: p.shop_orders?.total_price || null,
        customer_name: p.shop_orders?.customer_name || null,
        customer_phone: p.shop_orders?.customer_phone || null,
      }
    })

    // Calculate stats using aggregate queries to avoid 1000 row limit
    // Total profit (all statuses)
    const { data: totalData } = await supabase
      .from("shop_profits")
      .select("profit_amount")
    
    // We need to paginate through all records for accurate stats
    // Use RPC function or calculate from multiple queries
    let allProfits: any[] = []
    let statsOffset = 0
    const statsLimit = 1000
    let hasMore = true
    
    while (hasMore) {
      const { data: batchData } = await supabase
        .from("shop_profits")
        .select("profit_amount, status")
        .range(statsOffset, statsOffset + statsLimit - 1)
      
      if (batchData && batchData.length > 0) {
        allProfits = allProfits.concat(batchData)
        statsOffset += statsLimit
        hasMore = batchData.length === statsLimit
      } else {
        hasMore = false
      }
    }

    let totalProfit = 0
    let pendingProfit = 0
    let creditedProfit = 0
    let withdrawnProfit = 0
    let pendingCount = 0
    let creditedCount = 0
    let withdrawnCount = 0

    allProfits.forEach((p: any) => {
      const amount = p.profit_amount || 0
      totalProfit += amount

      if (p.status === "pending") {
        pendingProfit += amount
        pendingCount++
      } else if (p.status === "credited") {
        creditedProfit += amount
        creditedCount++
      } else if (p.status === "withdrawn") {
        withdrawnProfit += amount
        withdrawnCount++
      }
    })

    const totalCount = search ? totalFilteredCount : (count || 0)

    console.log("[ADMIN-PROFITS] Returning", flattenedProfits.length, "profits, total:", totalCount, "stats from", allProfits.length, "records")

    return NextResponse.json({
      profits: flattenedProfits,
      stats: {
        totalProfit,
        pendingProfit,
        creditedProfit,
        withdrawnProfit,
        pendingCount,
        creditedCount,
        withdrawnCount,
        totalRecords: allProfits.length,
      },
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
