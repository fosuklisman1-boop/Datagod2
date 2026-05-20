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

    // Use count-only queries per status to avoid the 1000-row default limit on PostgREST.
    // { count: "exact", head: true } emits SELECT COUNT(*) with no row data returned.
    const base = () =>
      supabase
        .from("combined_orders_view")
        .select("id", { count: "exact", head: true })
        .eq("shop_owner_id", userId)

    const [totalRes, completedRes, processingRes, failedRes, pendingRes] = await Promise.all([
      base(),
      base().eq("status", "completed"),
      base().eq("status", "processing"),
      base().eq("status", "failed"),
      base().eq("status", "pending"),
    ])

    const anyError = totalRes.error || completedRes.error || processingRes.error || failedRes.error || pendingRes.error
    if (anyError) {
      console.error("Error fetching orders stats:", anyError)
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      )
    }

    const total = totalRes.count ?? 0
    const completed = completedRes.count ?? 0
    const processing = processingRes.count ?? 0
    const failed = failedRes.count ?? 0
    const pending = pendingRes.count ?? 0
    const successRate = total > 0 ? (completed / total) * 100 : 0

    return NextResponse.json({
      totalOrders: total,
      completed,
      processing,
      failed,
      pending,
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
