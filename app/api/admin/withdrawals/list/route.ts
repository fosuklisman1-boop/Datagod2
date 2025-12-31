import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status") || "pending"

    let query = supabase
      .from("withdrawal_requests")
      .select("id, shop_id, user_id, amount, fee_amount, net_amount, status, created_at, updated_at, account_details, withdrawal_method, reference_code, rejection_reason")

    if (status !== "all") {
      query = query.eq("status", status)
    }

    const { data, error } = await query.order("created_at", { ascending: false })

    if (error) {
      console.error("[WITHDRAWALS-API] Error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    console.log(`[WITHDRAWALS-API] Status: ${status}, Count: ${data?.length || 0}`)

    // Fetch shop details and available balance for each withdrawal
    if (data && data.length > 0) {
      const shopIds = [...new Set(data.map((w: any) => w.shop_id))]
      
      // Fetch shop details
      const { data: shops, error: shopsError } = await supabase
        .from("user_shops")
        .select("id, shop_name, shop_slug")
        .in("id", shopIds)

      // Fetch available balance for each shop
      const { data: balances, error: balancesError } = await supabase
        .from("shop_available_balance")
        .select("shop_id, available_balance")
        .in("shop_id", shopIds)

      const shopMap = shops ? new Map(shops.map((s: any) => [s.id, s])) : new Map()
      const balanceMap = balances ? new Map(balances.map((b: any) => [b.shop_id, b.available_balance])) : new Map()

      const enrichedData = data.map((w: any) => ({
        ...w,
        user_shops: shopMap.get(w.shop_id),
        current_available_balance: balanceMap.get(w.shop_id) || 0
      }))
      return NextResponse.json(enrichedData)
    }

    return NextResponse.json(data || [])
  } catch (error) {
    console.error("[WITHDRAWALS-API] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
