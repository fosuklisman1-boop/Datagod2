import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"))
    const limit = Math.min(50, parseInt(searchParams.get("limit") ?? "20"))
    const examBoard = searchParams.get("examBoard")
    const offset = (page - 1) * limit

    let query = supabase
      .from("results_checker_orders")
      .select("*", { count: "exact" })
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    if (examBoard) query = query.eq("exam_board", examBoard)

    const { data: orders, count, error } = await query

    if (error) throw error

    // For completed orders, fetch the PIN data
    const completedOrders = (orders ?? []).filter(o => o.status === "completed" && o.inventory_ids?.length)
    const allInventoryIds = completedOrders.flatMap(o => o.inventory_ids ?? [])

    let voucherMap: Record<string, Array<{ pin: string; serial_number: string | null }>> = {}

    if (allInventoryIds.length > 0) {
      const { data: inventory } = await supabase
        .from("results_checker_inventory")
        .select("id, pin, serial_number, reserved_by_order")
        .in("id", allInventoryIds)

      // Group PINs by order id via reserved_by_order
      for (const item of inventory ?? []) {
        const order = completedOrders.find(o => (o.inventory_ids ?? []).includes(item.id))
        if (order) {
          if (!voucherMap[order.id]) voucherMap[order.id] = []
          voucherMap[order.id].push({ pin: item.pin, serial_number: item.serial_number })
        }
      }
    }

    const enriched = (orders ?? []).map(order => ({
      ...order,
      vouchers: voucherMap[order.id] ?? [],
    }))

    return NextResponse.json({ orders: enriched, total: count ?? 0, page, limit })

  } catch (error) {
    console.error("[RC-MY-ORDERS] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
