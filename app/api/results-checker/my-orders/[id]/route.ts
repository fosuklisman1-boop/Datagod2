import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { data: order, error } = await supabase
      .from("results_checker_orders")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single()

    if (error || !order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 })
    }

    let vouchers: Array<{ pin: string; serial_number: string | null }> = []

    if (order.status === "completed" && order.inventory_ids?.length) {
      const { data: inventory } = await supabase
        .from("results_checker_inventory")
        .select("pin, serial_number")
        .in("id", order.inventory_ids)

      vouchers = inventory ?? []
    }

    return NextResponse.json({ order, vouchers })

  } catch (error) {
    console.error("[RC-ORDER-DETAIL] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
