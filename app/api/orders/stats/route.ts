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

    // Get total orders count
    const { count: totalCount } = await supabase
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)

    // Get completed orders
    const { count: completedCount } = await supabase
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("order_status", "completed")

    // Get processing orders
    const { count: processingCount } = await supabase
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("order_status", "processing")

    // Get failed orders
    const { count: failedCount } = await supabase
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("order_status", "failed")

    const total = totalCount || 0
    const completed = completedCount || 0
    const successRate = total > 0 ? (completed / total) * 100 : 0

    return NextResponse.json({
      totalOrders: total,
      completed,
      processing: processingCount || 0,
      failed: failedCount || 0,
      successRate,
    })
  } catch (error) {
    console.error("Error fetching orders stats:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
