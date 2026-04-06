import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { data: shopOrders } = await supabase
      .from("shop_orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5)

    const { data: bulkOrders } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5)

    const { data: profits } = await supabase
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
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
