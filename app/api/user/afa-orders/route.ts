import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function GET(request: NextRequest) {
  try {
    // Get auth header
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.substring(7)
    const supabase = createClient(supabaseUrl, serviceRoleKey)

    // Verify token and get user
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Fetch all AFA orders for the user
    const { data: afaOrders, error: afaError } = await supabase
      .from("afa_orders")
      .select(`
        id,
        user_id,
        order_code,
        transaction_code,
        full_name,
        phone_number,
        gh_card_number,
        location,
        region,
        occupation,
        amount,
        status,
        created_at
      `)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })

    if (afaError) {
      console.error("[USER-AFA-ORDERS] Error fetching AFA orders:", afaError)
      return NextResponse.json(
        { error: "Failed to fetch orders" },
        { status: 500 }
      )
    }

    // Calculate stats
    const stats = {
      total: (afaOrders || []).length,
      pending: (afaOrders || []).filter(o => o.status === "pending").length,
      processing: (afaOrders || []).filter(o => o.status === "processing").length,
      completed: (afaOrders || []).filter(o => o.status === "completed").length,
      cancelled: (afaOrders || []).filter(o => o.status === "cancelled").length,
    }

    return NextResponse.json(
      {
        orders: afaOrders || [],
        stats,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("[USER-AFA-ORDERS] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
