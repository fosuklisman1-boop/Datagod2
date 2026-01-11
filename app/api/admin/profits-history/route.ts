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

    // Build query for profit records with shop and user details
    let query = supabase
      .from("shop_profits")
      .select(`
        id,
        shop_id,
        shop_order_id,
        profit_amount,
        status,
        credited_at,
        created_at,
        user_shops!inner (
          id,
          shop_name,
          shop_slug,
          user_id,
          users!inner (
            id,
            email,
            first_name,
            last_name,
            phone_number
          )
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

    // Apply pagination
    query = query.range(offset, offset + limit - 1)

    const { data: profits, error, count } = await query

    if (error) {
      console.error("[ADMIN-PROFITS] Error fetching profits:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      )
    }

    // Filter by search if provided (post-query for complex joins)
    let filteredProfits = profits || []
    if (search) {
      const searchLower = search.toLowerCase()
      filteredProfits = filteredProfits.filter((p: any) => {
        const shopName = p.user_shops?.shop_name?.toLowerCase() || ""
        const ownerEmail = p.user_shops?.users?.email?.toLowerCase() || ""
        const ownerName = `${p.user_shops?.users?.first_name || ""} ${p.user_shops?.users?.last_name || ""}`.toLowerCase()
        const orderRef = p.shop_orders?.reference_code?.toLowerCase() || ""
        
        return shopName.includes(searchLower) || 
               ownerEmail.includes(searchLower) || 
               ownerName.includes(searchLower) ||
               orderRef.includes(searchLower)
      })
    }

    // Flatten data for frontend
    const flattenedProfits = filteredProfits.map((p: any) => ({
      id: p.id,
      shop_id: p.shop_id,
      shop_order_id: p.shop_order_id,
      profit_amount: p.profit_amount ?? 0,
      status: p.status,
      credited_at: p.credited_at,
      created_at: p.created_at,
      shop_name: p.user_shops?.shop_name || "Unknown Shop",
      shop_slug: p.user_shops?.shop_slug || "",
      owner_email: p.user_shops?.users?.email || "Unknown",
      owner_first_name: p.user_shops?.users?.first_name || null,
      owner_last_name: p.user_shops?.users?.last_name || null,
      owner_phone: p.user_shops?.users?.phone_number || null,
      order_reference: p.shop_orders?.reference_code || null,
      order_network: p.shop_orders?.network || null,
      order_volume_gb: p.shop_orders?.volume_gb || null,
      order_total_price: p.shop_orders?.total_price || null,
      customer_name: p.shop_orders?.customer_name || null,
      customer_phone: p.shop_orders?.customer_phone || null,
    }))

    // Calculate stats (all time)
    const { data: statsData } = await supabase
      .from("shop_profits")
      .select("profit_amount, status")

    let totalProfit = 0
    let pendingProfit = 0
    let creditedProfit = 0
    let withdrawnProfit = 0
    let pendingCount = 0
    let creditedCount = 0
    let withdrawnCount = 0

    statsData?.forEach((p: any) => {
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

    const totalCount = search ? filteredProfits.length : (count || 0)

    console.log("[ADMIN-PROFITS] Returning", flattenedProfits.length, "profits, total:", totalCount)

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
        totalRecords: statsData?.length || 0,
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
