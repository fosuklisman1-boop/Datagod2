import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse || NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const date       = searchParams.get("date")
    const network    = searchParams.get("network")
    const status     = searchParams.get("status")
    const search     = searchParams.get("search")
    const page       = parseInt(searchParams.get("page") || "1")
    const limit      = parseInt(searchParams.get("limit") || "50")
    const offset     = (page - 1) * limit

    console.log(`[AIRTIME-LIST] Filters - Date: ${date}, Net: ${network}, Status: ${status}, Search: ${search}`)

    // Build query - Restored join with disambiguation
    let query = supabase
      .from("airtime_orders")
      .select("*, users!airtime_orders_user_id_fkey_public(email), user_shops(shop_name)", { count: "exact" })

    if (date && date !== "all") {
      query = query
        .gte("created_at", `${date}T00:00:00Z`)
        .lte("created_at", `${date}T23:59:59Z`)
    }
    if (network && network !== "all") {
      query = query.eq("network", network)
    }
    if (status && status !== "all") {
      query = query.eq("status", status)
    }
    if (search) {
      query = query.or(`reference_code.ilike.%${search}%,beneficiary_phone.ilike.%${search}%`)
    }

    const { data: orders, error, count } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      console.error("[AIRTIME-LIST] Query Error:", error)
      throw error
    }

    // DEBUG: Check how many rows exist in the table TOTAL
    const { count: totalAllOrders } = await supabase.from("airtime_orders").select("*", { count: "exact", head: true })
    console.log(`[AIRTIME-LIST] Found ${orders?.length || 0} filtered orders (Total matching: ${count}). Total rows in table: ${totalAllOrders}`)

    // Aggregate stats for filtered set (whole matching set, not just one page)
    let statsQuery = supabase
      .from("airtime_orders")
      .select("airtime_amount, fee_amount, total_paid, status, merchant_commission")

    if (date && date !== "all") {
      statsQuery = statsQuery
        .gte("created_at", `${date}T00:00:00Z`)
        .lte("created_at", `${date}T23:59:59Z`)
    }
    if (network && network !== "all") {
      statsQuery = statsQuery.eq("network", network)
    }

    const { data: statsData } = await statsQuery

    const stats = (statsData || []).reduce(
      (acc, o) => {
        acc.totalRevenue += Number(o.total_paid || 0)
        acc.totalProfit  += Number(o.fee_amount || 0)
        acc.totalMerchantPayout += Number(o.merchant_commission || 0)
        acc.totalVolume  += Number(o.airtime_amount || 0)
        const s = o.status || 'pending'
        acc[s] = (acc[s] || 0) + 1
        return acc
      },
      { totalRevenue: 0, totalProfit: 0, totalMerchantPayout: 0, totalVolume: 0, pending: 0, processing: 0, completed: 0, failed: 0 } as Record<string, number>
    )

    return NextResponse.json({
      orders: orders || [],
      total: count || 0,
      page,
      limit,
      stats,
    })
  } catch (error) {
    console.error("[AIRTIME-LIST] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
