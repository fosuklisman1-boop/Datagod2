import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  try {
    // Auth — admin only
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if (user.user_metadata?.role !== "admin") {
      return NextResponse.json({ error: "Forbidden: Admin access required" }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const date       = searchParams.get("date")
    const network    = searchParams.get("network")
    const status     = searchParams.get("status")
    const search     = searchParams.get("search")
    const page       = parseInt(searchParams.get("page") || "1")
    const limit      = parseInt(searchParams.get("limit") || "50")
    const offset     = (page - 1) * limit

    console.log(`[AIRTIME-LIST] Filters - Date: ${date}, Net: ${network}, Status: ${status}, Search: ${search}`)

    // Build query - temporarily remove users join to check if it's the issue
    let query = supabase
      .from("airtime_orders")
      .select(`
        id, reference_code, network, beneficiary_phone,
        airtime_amount, fee_amount, total_paid, pay_separately,
        status, notes, created_at, updated_at, user_id,
        users:user_id(email)
      `, { count: "exact" })

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

    console.log(`[AIRTIME-LIST] Found ${orders?.length || 0} orders (Total: ${count})`)

    // Aggregate stats for filtered set (whole matching set, not just one page)
    let statsQuery = supabase
      .from("airtime_orders")
      .select("airtime_amount, fee_amount, total_paid, status")

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
        acc.totalRevenue += o.total_paid || 0
        acc.totalProfit  += o.fee_amount || 0
        acc.totalVolume  += o.airtime_amount || 0
        acc[o.status]    = (acc[o.status] || 0) + 1
        return acc
      },
      { totalRevenue: 0, totalProfit: 0, totalVolume: 0, pending: 0, processing: 0, completed: 0, failed: 0 } as Record<string, number>
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
