import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = user.id
    const { searchParams } = new URL(request.url)
    const page = parseInt(searchParams.get("page") || "1")
    const limit = parseInt(searchParams.get("limit") || "10")
    const network = searchParams.get("network")
    const status = searchParams.get("status")
    const dateRange = searchParams.get("dateRange")

    const offset = (page - 1) * limit

    // Build the query using the unified view
    let query = supabase
      .from("combined_orders_view")
      .select(
        `
        id,
        created_at,
        phone_number,
        price,
        status,
        network,
        volume_gb,
        type
        `,
        { count: "exact" }
      )
      .eq("shop_owner_id", userId)
      .order("created_at", { ascending: false })

    // Apply filters
    if (network && network !== "all") {
      query = query.eq("network", network)
    }

    if (status && status !== "all") {
      query = query.eq("status", status)
    }

    if (dateRange && dateRange !== "all") {
      const now = new Date()
      let startDate: Date

      switch (dateRange) {
        case "today":
          startDate = new Date(now)
          startDate.setHours(0, 0, 0, 0)
          break
        case "week":
          startDate = new Date(now)
          startDate.setDate(now.getDate() - 7)
          break
        case "month":
          startDate = new Date(now)
          startDate.setMonth(now.getMonth() - 1)
          break
        case "3months":
          startDate = new Date(now)
          startDate.setMonth(now.getMonth() - 3)
          break
        default:
          startDate = new Date(0)
      }

      query = query.gte("created_at", startDate.toISOString())
    }

    const { data: ordersData, error, count } = await query.range(offset, offset + limit - 1)

    if (error) {
      console.error("Error fetching orders from view:", error)
      return NextResponse.json(
        { error: "Failed to fetch orders" },
        { status: 400 }
      )
    }

    // Transform the data for the frontend
    const orders = (ordersData || []).map((order: any) => ({
      id: order.id,
      created_at: order.created_at,
      phone_number: order.phone_number,
      total_price: Number(order.price) ?? 0,
      order_status: order.status ?? "pending",
      package_name: order.volume_gb ? `${order.volume_gb}GB` : "Unknown",
      network_name: order.network || "Unknown",
      type: order.type
    }))

    return NextResponse.json({
      orders,
      pagination: {
        page,
        limit,
        total: count || 0,
        pages: Math.ceil((count || 0) / limit),
      },
    })
  } catch (error) {
    console.error("Error in orders list endpoint:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
