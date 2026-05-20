import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status")
    const examBoard = searchParams.get("examBoard")
    const date = searchParams.get("date")
    const search = searchParams.get("search")
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"))
    const limit = Math.min(100, parseInt(searchParams.get("limit") ?? "50"))
    const offset = (page - 1) * limit

    let query = supabase
      .from("results_checker_orders")
      .select(`
        *,
        user_shops (shop_name)
      `, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    if (status) query = query.eq("status", status)
    if (examBoard) query = query.eq("exam_board", examBoard)
    if (date) query = query.gte("created_at", `${date}T00:00:00`).lte("created_at", `${date}T23:59:59`)
    if (search) {
      query = query.or(`reference_code.ilike.%${search}%,customer_email.ilike.%${search}%`)
    }

    const { data: orders, count, error } = await query
    if (error) throw error

    // Aggregate stats for filtered set (only completed payments)
    const completedOrders = (orders ?? []).filter(o => o.payment_status === "completed")
    const stats = {
      total: count ?? 0,
      revenue: completedOrders.reduce((s, o) => s + Number(o.total_paid), 0),
      merchantPayouts: completedOrders.reduce((s, o) => s + Number(o.merchant_commission ?? 0), 0),
      byStatus: {
        pending: (orders ?? []).filter(o => o.status === "pending").length,
        pending_payment: (orders ?? []).filter(o => o.status === "pending_payment").length,
        completed: (orders ?? []).filter(o => o.status === "completed").length,
        failed: (orders ?? []).filter(o => o.status === "failed").length,
      },
    }

    return NextResponse.json({ orders, total: count ?? 0, page, limit, stats })

  } catch (error) {
    console.error("[RC-ADMIN-LIST] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
