import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    // Verify authenticated user
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { phone, shopId } = await request.json()

    if (!phone || !shopId) {
      return NextResponse.json(
        { error: "Phone number and shop ID are required" },
        { status: 400 }
      )
    }

    // Verify the authenticated user owns this shop
    const { data: shop } = await supabase
      .from("user_shops")
      .select("id")
      .eq("id", shopId)
      .eq("user_id", user.id)
      .single()

    if (!shop) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { data: dataOrders } = await supabase
      .from("shop_orders")
      .select("*")
      .eq("shop_id", shopId)
      .eq("customer_phone", phone.trim())
      .order("created_at", { ascending: false })

    const { data: airtimeOrders } = await supabase
      .from("airtime_orders")
      .select("*")
      .eq("shop_id", shopId)
      .eq("beneficiary_phone", phone.trim())
      .order("created_at", { ascending: false })

    const combinedOrders = [
      ...(dataOrders || []).map(o => ({ ...o, type: 'data' })),
      ...(airtimeOrders || []).map(o => ({
        ...o,
        type: 'airtime',
        volume_gb: o.airtime_amount,
        customer_phone: o.beneficiary_phone,
        customer_name: o.customer_name || 'N/A',
        customer_email: o.customer_email || '',
        base_price: Number(o.airtime_amount) || 0,
        total_price: Number(o.total_paid) || 0,
        profit_amount: Number(o.fee_amount) || 0,
        order_status: o.status || 'pending',
        reference_code: o.reference_code || o.id,
      }))
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    return NextResponse.json({ success: true, orders: combinedOrders, count: combinedOrders.length })
  } catch (error) {
    console.error("[SHOP-ORDER-SEARCH] Error searching orders:", error)
    return NextResponse.json({ error: "Internal server error", success: false }, { status: 500 })
  }
}
