import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  try {
    // Get latest shop orders
    const { data: shopOrders, error: shopOrdersError } = await supabase
      .from("shop_orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5)

    // Get latest bulk orders
    const { data: bulkOrders, error: bulkOrdersError } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5)

    // Get latest profit records
    const { data: profits, error: profitsError } = await supabase
      .from("shop_profits")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5)

    return NextResponse.json({
      latestShopOrders: shopOrders,
      latestBulkOrders: bulkOrders,
      latestProfits: profits,
      counts: {
        totalShopOrders: shopOrders?.length,
        totalBulkOrders: bulkOrders?.length,
        totalProfits: profits?.length,
      }
    })
  } catch (error) {
    console.error("Debug error:", error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
